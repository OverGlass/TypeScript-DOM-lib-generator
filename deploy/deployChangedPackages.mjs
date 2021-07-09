// @ts-check

// node deploy/deployChangedPackages.mjs

// Builds on the results of createTypesPackages.mjs and deploys the
// ones which have changed.

import * as fs from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync, execSync } from "child_process";
import { Octokit } from "@octokit/core";
import printDiff from "print-diff";
import { generateChangelogFrom } from "../lib/changelog.js";
import { packages } from "./createTypesPackages.mjs";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

verify();

const uploaded = [];

// Loop through generated packages, deploying versions for anything which has different
// .d.ts files from the version available on npm.
const generatedDir = join(__dirname, "generated");
for (const dirName of fs.readdirSync(generatedDir)) {
  console.log(`Looking at ${dirName}`);
  const localPackageJSONPath = join(generatedDir, dirName, "package.json");
  const newTSConfig = fs.readFileSync(localPackageJSONPath, "utf-8");
  const pkgJSON = JSON.parse(newTSConfig);

  // We'll need to map back from the filename in the npm package to the
  // generated file in baselines inside the git tag
  const thisPackageMeta = packages.find((p) => p.name === pkgJSON.name);

  const dtsFiles = fs
    .readdirSync(join(generatedDir, dirName))
    .filter((f) => f.endsWith(".d.ts"));

  /** @type {string[]} */
  let releaseNotes = [];

  // Look through each .d.ts file included in a package to
  // determine if anything has changed
  let upload = false;
  for (const file of dtsFiles) {
    const originalFilename = basename(
      thisPackageMeta.files.find((f) => f.to === file).from
    );

    const generatedDTSPath = join(generatedDir, dirName, file);
    const generatedDTSContent = fs.readFileSync(generatedDTSPath, "utf8");

    // This assumes we'll only _ever_ ship patches, which may change in the
    // future someday.
    const [maj, min, patch] = pkgJSON.version.split(".");
    const olderVersion = `${maj}.${min}.${patch - 1}`;

    try {
      const oldFile = gitShowFile(
        `${pkgJSON.name}@${olderVersion}`,
        `baselines/${originalFilename}`
      );
      console.log(`Comparing ${file} from ${olderVersion}, to now:`);
      printDiff(oldFile, generatedDTSContent);

      const title = `\n## \`${file}\`\n`;
      const notes = generateChangelogFrom(oldFile, generatedDTSContent);
      releaseNotes.push(title);
      releaseNotes.push(notes.trim() === "" ? "No changes" : notes);

      upload = upload || oldFile !== generatedDTSContent;
    } catch (error) {
      // Could not find a previous build
      console.log(`
Could not get the file ${file} inside the npm package ${pkgJSON.name} from tag ${olderVersion}.
Assuming that this means we need to upload this package.`);
      upload = true;
    }
  }

  // Publish via npm
  if (upload) {
    if (process.env.NODE_AUTH_TOKEN) {
      const publish = spawnSync("npm", ["publish", "--access", "public"], {
        cwd: join(generatedDir, dirName),
        stdio: "inherit",
      });

      if (publish.status) {
        console.log(publish.stdout?.toString());
        console.log(publish.stderr?.toString());
        process.exit(publish.status);
      } else {
        console.log(publish.stdout?.toString());

        await createRelease(`${pkgJSON.name}@${pkgJSON.version}`);
      }
    } else {
      console.log(
        "Wanting to run: 'npm publish --access public' in " +
          join(generatedDir, dirName)
      );
    }

    uploaded.push(dirName);
  }

  console.log("\n# Release notes:");
  console.log(releaseNotes.join("\n"), "\n\n");
}
// Warn if we did a dry run.
if (!process.env.NODE_AUTH_TOKEN) {
  console.log("Did a dry run because process.env.NODE_AUTH_TOKEN is not set.");
}

if (uploaded.length) {
  console.log("Uploaded: ", uploaded.join(", "));
} else {
  console.log("No uploads");
}

async function createRelease(tag, body) {
  const authToken = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
  const octokit = new Octokit({ auth: authToken });

  try {
    await octokit.request("POST /repos/{owner}/{repo}/releases", {
      owner: "microsoft",
      repo: "TypeScript-DOM-lib-generator",
      tag_name: tag,
      target_commitish: process.env.GITHUB_SHA,
      name: tag,
      body,
    });
  } catch (error) {
    console.error(
      "Creating the GitHub release failed, this is likely due to re-running the deploy."
    );
  }
}

function verify() {
  const authToken = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
  if (!authToken)
    throw new Error(
      "There isn't an ENV var set up for creating a GitHub release, expected GITHUB_TOKEN."
    );
}

function gitShowFile(commitish, path) {
  return execSync(`git show "${commitish}":${path}`, { encoding: "utf-8" });
}
