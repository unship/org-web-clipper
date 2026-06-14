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
		await convertSvgsToImages(readerDoc);
		return new Defuddle(readerDoc, { url: '' }).parse();
	}
	await convertSvgsToImages(doc);
	return new Defuddle(doc, { url: doc.URL }).parse();
}
