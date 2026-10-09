// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
	// Base ObsidianMD rules (global)
	...obsidianmd.configs.recommended,

	// Ignore build artifacts and dependencies
	{
		ignores: ["main.js", "node_modules/**", "dist/**", ".esbuild/**"],
	},

	// Define globals for both browser and Node.js environments
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
				NodeJS: "readonly",
			},
		},
	},

	// JS files — prevent typed rules from running here
	{
		files: ["**/*.js"],
		ignores: ["main.js", "node_modules/**"],
		rules: {
			"@typescript-eslint/no-deprecated": "off",
			// Add any other typed rules you want disabled for JS
		},
	},

	// TS files — full type-aware linting
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: "./tsconfig.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["Folder Bridge", "Obsidian", "Windows", "OneDrive", "SharePoint", "File Explorer", "Excel", "Word", "Markdown", "Bases", "Finance", "Reports", "Z:"],
					acronyms: ["OK", "UI", "PC", "PDF", "UNC", "URL", "ID"],
					enforceCamelCaseLower: true,
				},
			],
		},
	},
]);
