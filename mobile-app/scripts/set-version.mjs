// Sets the app version everywhere it lives, so Android, iOS and the user agent agree.
//   npm run version:set -- 1.1.0 2     (version name, build number)
// The build number must go up with every upload to Google Play / App Store Connect.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [version, build] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || "") || !/^\d+$/.test(build || "")) {
  console.error("Usage: npm run version:set -- <major.minor.patch> <build number>   e.g. 1.1.0 2");
  process.exit(1);
}

async function update(file, edits) {
  const p = path.join(root, file);
  let s = await readFile(p, "utf8");
  for (const [re, value] of edits) {
    if (!re.test(s)) throw new Error(`${file}: ${re} not found`);
    s = s.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), value);
  }
  await writeFile(p, s);
  console.log(`updated ${file}`);
}

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
pkg.version = version;
await writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log("updated package.json");
await update("android/app/build.gradle", [
  [/versionCode \d+/, `versionCode ${build}`],
  [/versionName "[^"]*"/, `versionName "${version}"`],
]);
await update("ios/App/App.xcodeproj/project.pbxproj", [
  [/MARKETING_VERSION = [^;]+;/, `MARKETING_VERSION = ${version};`],
  [/CURRENT_PROJECT_VERSION = [^;]+;/, `CURRENT_PROJECT_VERSION = ${build};`],
]);
console.log(`Version ${version} (${build}). Run a sync so the app's user agent picks it up.`);
