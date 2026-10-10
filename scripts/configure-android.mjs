// Sets the Android application ID and the website address everywhere they appear, in one step.
//
//   node scripts/configure-android.mjs --id com.yourname.routepilot --url https://your-site.vercel.app [--dry-run] [--root <project dir>]
//
// The application ID is PERMANENT once you upload to Google Play. Pick it carefully:
//   - lowercase letters, digits and underscores, at least two dot-separated parts, each part starting with a letter
//   - NOT "com.example.*" (Play rejects it) and NOT "android.*"
//   - usually your reversed domain or name, e.g. com.srijanbajpai.routepilot
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const root = resolve(opt("root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const newId = opt("id");
const newUrl = opt("url")?.replace(/\/+$/, "");
const dry = flag("dry-run");

function fail(msg) { console.error(`\nERROR: ${msg}\n`); process.exit(1); }

if (!newId || !newUrl) fail("usage: node scripts/configure-android.mjs --id <com.yourname.app> --url <https://your-site> [--dry-run]");
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(newId)) fail(`"${newId}" is not a valid Android application ID (lowercase letters/digits/underscores, 2+ dot-separated parts, each starting with a letter).`);
if (/^com\.example(\.|$)/.test(newId) || /^android(\.|$)/.test(newId)) fail(`Google Play rejects IDs starting with "com.example" or "android". Choose your own.`);
if (newId.split(".").some((p) => ["abstract", "class", "default", "package", "public", "private", "new", "null", "true", "false", "int", "long", "static", "void", "import", "native"].includes(p))) fail("An ID part is a reserved Java keyword; pick another word.");
let host;
try { const u = new URL(newUrl); if (u.protocol !== "https:") throw new Error("not https"); host = u.host; } catch { fail(`"${newUrl}" must be a full https:// address, e.g. https://your-site.vercel.app`); }

const p = (...parts) => join(root, ...parts);
const read = (f) => readFileSync(f, "utf8");
const changes = [];
function write(file, text) { if (read(file) !== text) { changes.push(file.replace(root, ".")); if (!dry) writeFileSync(file, text); } }

const capFile = p("capacitor.config.ts");
if (!existsSync(capFile) || !existsSync(p("android"))) fail(`Run this from the project folder (capacitor.config.ts and android/ not found in ${root}).`);
const oldId = read(capFile).match(/appId:\s*"([^"]+)"/)?.[1];
if (!oldId) fail("Could not find appId in capacitor.config.ts");

// 1. application id everywhere (config, gradle, manifest scheme, strings, brand, asset links)
const files = [capFile, p("android/app/build.gradle"), p("android/app/src/main/AndroidManifest.xml"), p("android/app/src/main/res/values/strings.xml"), p("src/config/brand.ts"), p("assetlinks.template.json")].filter(existsSync);
for (const f of files) write(f, read(f).split(oldId).join(newId));

// 2. website address: capacitor default + the https App Link host in the manifest
write(capFile, read(capFile).replace(/(CAP_SERVER_URL \?\? ")[^"]+(")/, `$1${newUrl}$2`));
const manifest = p("android/app/src/main/AndroidManifest.xml");
write(manifest, read(manifest).replace(/(android:scheme="https" android:host=")[^"]+(")/, `$1${host}$2`));

// 2b. the generated copy that the native app actually reads (also rewritten by `npx cap sync android`)
const assetCfg = p("android/app/src/main/assets/capacitor.config.json");
if (existsSync(assetCfg)) {
  const j = JSON.parse(read(assetCfg));
  j.appId = newId;
  j.server = { ...(j.server ?? {}), url: newUrl, allowNavigation: [host, "*.supabase.co"] };
  write(assetCfg, JSON.stringify(j, null, 2) + "\n");
}

// 3. Java package of MainActivity: update the package line and move the file into the matching folder
const javaRoot = p("android/app/src/main/java");
const oldFile = join(javaRoot, ...oldId.split("."), "MainActivity.java");
const newFile = join(javaRoot, ...newId.split("."), "MainActivity.java");
if (existsSync(oldFile) && oldFile !== newFile) {
  changes.push(`${oldFile.replace(root, ".")} -> ${newFile.replace(root, ".")}`);
  if (!dry) {
    mkdirSync(dirname(newFile), { recursive: true });
    writeFileSync(newFile, read(oldFile).replace(/^package\s+[\w.]+;/m, `package ${newId};`));
    unlinkSync(oldFile);
    // remove any directories the move left empty (stops at the first non-empty one)
    for (let d = dirname(oldFile); d !== javaRoot && d.startsWith(javaRoot); d = dirname(d)) {
      if (readdirSync(d).length === 0) rmdirSync(d);
      else break;
    }
  }
} else if (existsSync(newFile)) {
  write(newFile, read(newFile).replace(/^package\s+[\w.]+;/m, `package ${newId};`));
}

console.log(`${dry ? "[dry run] would change" : "Changed"} ${changes.length} item(s):`);
for (const c of changes) console.log("  - " + c);
console.log(`
Application ID : ${oldId}  ->  ${newId}
Website        : ${newUrl}  (host ${host})

Next:
  1. Supabase > Authentication > URL configuration > Redirect URLs: add   ${newId}://auth/callback
  2. Publish   ${newUrl}/.well-known/assetlinks.json   (template: assetlinks.template.json) with your Play App Signing SHA-256.
  3. Rebuild: CAP_SERVER_URL=${newUrl} npx cap sync android, then build the signed bundle (see ANDROID_RELEASE.md).
`);
