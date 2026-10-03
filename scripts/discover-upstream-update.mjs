import { appendFile, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const POST_LIST_URL = "https://scevo.org/assets/data/postList.json";
const OFFICIAL_ORIGIN = "https://scevo.org";

function parseVersion(value) {
  const match = String(value || "").match(/\d+(?:\.\d+){1,3}/);
  return match ? match[0].split(".").map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left) || [];
  const b = parseVersion(right) || [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

function getPublishedUpdate(post) {
  if (!post || typeof post !== "object" || !/patch\s*notes/i.test(String(post.title || ""))) return null;
  const match = String(post.link || "").match(/\/posts\/evo-update-(\d+(?:_\d+){1,3})(?:\.html)?$/i);
  if (!match) return null;
  const version = match[1].replaceAll("_", ".");
  return { version, url: `${OFFICIAL_ORIGIN}/posts/evo-update-${match[1]}` };
}

function getRecordedVersions(patchText) {
  const lines = patchText.replace(/^\uFEFF/, "").split(/\r?\n/);
  return lines.slice(1).filter((line) => {
    const columns = line.split(",");
    return /^\d+\.\d+(?:\.\d+){0,2}(?:\s*\([^)]*\))?(?:\s*\/\s*\d+\.\d+(?:\.\d+){0,2}(?:\s*\([^)]*\))?)*$/.test(columns[0] || "") &&
      !columns[6] && !columns[12] && !columns[18];
  }).map((line) => line.split(",", 1)[0] || "")
    .flatMap((cell) => cell.split("/"))
    .map((value) => value.trim().split("(", 1)[0].trim())
    .filter((value) => parseVersion(value))
    .map((value) => parseVersion(value).join("."));
}

async function fetchPostList() {
  const response = await fetch(POST_LIST_URL, {
    headers: { "User-Agent": "SC-Evo-Update-Checker/1.0" },
    redirect: "error"
  });
  if (!response.ok) throw new Error(`GET ${POST_LIST_URL}: HTTP ${response.status}`);
  const posts = await response.json();
  if (!Array.isArray(posts)) throw new Error("Official post list was not an array.");
  return posts;
}

async function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function addEmptyVersionBlock(patchText, version) {
  const hadBom = patchText.startsWith("\uFEFF");
  const body = hadBom ? patchText.slice(1) : patchText;
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  if (lines[0] == null || !lines[0].startsWith("공통,")) {
    throw new Error("Patch.csv header did not match the expected 25-column layout.");
  }
  const insertAt = lines.findIndex((line, index) => index > 0 && /^\d+\.\d+/.test(line.split(",", 1)[0] || ""));
  if (insertAt < 0) throw new Error("Could not find the latest version row in Patch.csv.");
  lines.splice(insertAt, 0, version);
  const updated = lines.join(newline);
  return `${hadBom ? "\uFEFF" : ""}${updated}`;
}

async function main() {
  const patchPath = process.argv[2] || "Patch.csv";
  const [patchText, posts] = await Promise.all([readFile(patchPath, "utf8"), fetchPostList()]);
  const recordedVersions = getRecordedVersions(patchText);
  if (!recordedVersions.length) throw new Error("Could not read any version from Patch.csv.");
  const recordedVersion = recordedVersions.reduce((latest, version) =>
    compareVersions(version, latest) > 0 ? version : latest
  );
  const nextUpdate = posts.map(getPublishedUpdate).filter(Boolean)
    .filter((post) => compareVersions(post.version, recordedVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version))[0];

  if (!nextUpdate) {
    await writeOutputs({ update_found: "false", recorded_version: recordedVersion });
    console.log(`No newer official patch notes. Patch.csv is at ${recordedVersion}.`);
    return;
  }

  const updatedCsv = addEmptyVersionBlock(patchText, nextUpdate.version);
  await writeFile(patchPath, updatedCsv, "utf8");
  await writeOutputs({
    update_found: "true",
    recorded_version: recordedVersion,
    version: nextUpdate.version,
    source_url: nextUpdate.url
  });
  console.log(`Added empty patch block ${nextUpdate.version}: ${nextUpdate.url}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
