import Defuddle from 'defuddle/full';
import { setElementHTML } from './dom-utils';
import { convertSvgsToImages } from './svg-converter';

// Parse document content for clipping. In reader mode, extracts from
// the article's original HTML to avoid reader UI artifacts.
export async function parseForClip(doc: Document) {
	const readerArticle = doc.querySelector('.obsidian-reader-active .obsidian-reader-content article');
	if (readerArticle) {
		const readerDoc = doc.implementation.createHTMLDocument();
		const originalHtml = readerArticle.getAttribute('data-original-html');
		if (originalHtml) {
			setElementHTML(readerDoc.body, originalHtml);
		} else {
			readerDoc.body.replaceChildren(
				...Array.from(readerArticle.childNodes).map(n => readerDoc.importNode(n, true))
			);
		}
		// readerDoc is a throwaway copy; rasterize and parse the returned document.
		const readerParseDoc = await convertSvgsToImages(readerDoc);
		return new Defuddle(readerParseDoc, { url: '' }).parse();
	}
	// Rasterize SVGs into a CLONE and parse that — parseForClip never modifies the
	// live page (convertSvgsToImages returns the original doc when nothing converts).
	const parseDoc = await convertSvgsToImages(doc);
	return new Defuddle(parseDoc, { url: doc.URL }).parse();
}
