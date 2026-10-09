import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	throw new Error(
		"version-bump.mjs: npm_package_version is not set. Run this script via an npm context (e.g. `npm version`)."
	);
}

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;

if (!minAppVersion) {
	throw new Error(
		"version-bump.mjs: manifest.json is missing `minAppVersion`. Cannot update versions.json."
	);
}
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
