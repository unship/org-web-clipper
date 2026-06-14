// Convert inline SVG elements to PNG images so they display properly in Org/Markdown
// instead of appearing as raw SVG code.

function getSvgDimensions(svg: SVGElement): { width: number; height: number } {
  const box = svg.getBoundingClientRect();
  let width = box.width || svg.getAttribute('width');
  let height = box.height || svg.getAttribute('height');

  const parseSize = (val: any): number => {
    if (typeof val === 'string') {
      const num = parseFloat(val);
      return isNaN(num) ? 100 : Math.max(num, 1);
    }
    return typeof val === 'number' ? Math.max(val, 1) : 100;
  };

  return {
    width: parseSize(width),
    height: parseSize(height)
  };
}

function convertSvgToPngAsync(svg: SVGElement): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const { width, height } = getSvgDimensions(svg);

      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }

      ctx.scale(dpr, dpr);
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, width, height);

      // Serialize SVG and create data URL
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const svgDataUrl = 'data:image/svg+xml;base64,' + btoa(new TextEncoder().encode(svgString).reduce((acc, byte) => acc + String.fromCharCode(byte), ''));

      const img = new Image();

      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0);
          const pngDataUrl = canvas.toDataURL('image/png');
          resolve(pngDataUrl);
        } catch {
          resolve(null);
        }
      };

      img.onerror = () => {
        resolve(null);
      };

      // Set source to trigger load
      img.src = svgDataUrl;

      // Timeout fallback in case image doesn't load
      setTimeout(() => resolve(null), 5000);
    } catch {
      resolve(null);
    }
  });
}

export async function convertSvgsToImages(doc: Document): Promise<void> {
  const svgs = Array.from(doc.querySelectorAll('svg'));

  if (svgs.length === 0) return;

  const conversions = await Promise.all(
    svgs.map(async (svg) => {
      const pngDataUrl = await convertSvgToPngAsync(svg);
      return { svg, pngDataUrl };
    })
  );

  // Replace SVGs with images
  for (const { svg, pngDataUrl } of conversions) {
    if (!pngDataUrl) continue;

    try {
      // Create img element with the PNG data URL
      const img = doc.createElement('img');
      img.src = pngDataUrl;
      img.alt = svg.getAttribute('aria-label') || svg.getAttribute('title') || 'Diagram';
      img.style.maxWidth = '100%';
      img.style.height = 'auto';

      // Copy relevant attributes
      if (svg.hasAttribute('width')) {
        const width = svg.getAttribute('width');
        if (width && !width.includes('%')) {
          img.setAttribute('width', width);
        }
      }
      if (svg.hasAttribute('height')) {
        const height = svg.getAttribute('height');
        if (height && !height.includes('%')) {
          img.setAttribute('height', height);
        }
      }

      // Replace SVG with image
      svg.replaceWith(img);
    } catch {
      // If conversion fails, keep the original SVG
    }
  }
}
