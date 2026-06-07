import { defineConfig } from 'vitest/config';

export default defineConfig({
	define: {
		DEBUG_MODE: false,
	},
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
		// Pin the timezone so date-rendering snapshots (e.g. {{date}} in the
		// template-integration fixtures) are reproducible on any machine.
		env: { TZ: 'UTC' },
		alias: {
			'webextension-polyfill': new URL('./src/utils/__mocks__/webextension-polyfill.ts', import.meta.url).pathname,
		},
	},
});
