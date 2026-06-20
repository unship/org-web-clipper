import { createMarkdownContent } from 'defuddle/full';
import { normalizeTableSpans } from '../table-normalizer';

export const markdown = (str: string, param?: string): string => {
	const baseUrl = param || 'about:blank';
	try {
		// Expand colspan/rowspan first so Defuddle emits a real Markdown table
		// rather than dumping raw <table> HTML for "complex" tables.
		return createMarkdownContent(normalizeTableSpans(str), baseUrl);
	} catch (error) {
		console.error('Error in createMarkdownContent:', error);
		return str;
	}
};