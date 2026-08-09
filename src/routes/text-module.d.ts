// Wrangler's Text rule (wrangler.jsonc `rules`) resolves these imports to the
// file's contents as a string. Declared here because the bundler does that at
// build time and TypeScript cannot infer it.
declare module "*.txt" {
	const content: string;
	export default content;
}
