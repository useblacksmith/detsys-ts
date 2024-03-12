import * as actions_core from "@actions/core";
import * as actionsCache from "@actions/cache";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
// eslint-disable-next-line import/no-unresolved
import got from "got";
import { v4 as uuidV4 } from "uuid";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";

const gotClient = got.extend({
  retry: {
    limit: 3,
    methods: ["GET", "HEAD"],
  },
  hooks: {
    beforeRetry: [
      (error, retryCount) => {
        actions_core.info(
          `Retrying after error ${error.code}, retry #: ${retryCount}`,
        );
      },
    ],
  },
});

type FetchSuffixStyle = "nix-style" | "gh-env-style" | "universal";

type SourceDef = {
  path?: string;
  url?: string;
  tag?: string;
  pr?: string;
  branch?: string;
  revision?: string;
};

class IdsToolbox {
  projectName: string;
  archOs: string;
  nixSystem: string;
  architectureFetchSuffix: string;
  correlation: string;
  sourceParameters: SourceDef;

  constructor(
    projectName: string,
    fetchStyle: FetchSuffixStyle,
    correlation: string,
    legacySourcePrefix?: string,
  ) {
    this.projectName = projectName;
    this.correlation = correlation;

    this.archOs = getArchOs();
    this.nixSystem = getNixPlatform(this.archOs);

    if (fetchStyle === "gh-env-style") {
      this.architectureFetchSuffix = this.archOs;
    } else if (fetchStyle === "nix-style") {
      this.architectureFetchSuffix = this.nixSystem;
    } else if (fetchStyle === "universal") {
      this.architectureFetchSuffix = "universal";
    } else {
      throw new Error(`fetchStyle ${fetchStyle} is not a valid style`);
    }

    this.sourceParameters = constructSourceParameters(legacySourcePrefix);
  }

  private getUrl(): URL {
    const p = this.sourceParameters;

    if (p.url) {
      return new URL(p.url);
    }

    const fetchUrl = new URL("https://install.determinate.systems/");
    fetchUrl.pathname += this.projectName;

    if (p.tag) {
      fetchUrl.pathname += `/tag/${p.tag}`;
    } else if (p.pr) {
      fetchUrl.pathname += `/pr/${p.pr}`;
    } else if (p.branch) {
      fetchUrl.pathname += `/branch/${p.branch}`;
    } else if (p.revision) {
      fetchUrl.pathname += `/rev/${p.revision}`;
    } else {
      fetchUrl.pathname += `/stable`;
    }

    fetchUrl.pathname += `/${this.architectureFetchSuffix}`;

    fetchUrl.searchParams.set("ci", "github");
    fetchUrl.searchParams.set("correlation", this.correlation);

    return fetchUrl;
  }

  private cacheKey(version: string): string {
    const cleanedVersion = version.replace(/[^a-zA-Z0-9-+.]/g, "");
    return `determinatesystem-${this.projectName}-${this.architectureFetchSuffix}-${cleanedVersion}`;
  }

  private async getCachedVersion(version: string): Promise<undefined | string> {
    const startCwd = process.cwd();

    try {
      const tempDir = this.getTemporaryName();
      await mkdir(tempDir);
      process.chdir(tempDir);

      if (
        await actionsCache.restoreCache(
          [this.projectName],
          this.cacheKey(version),
          [],
          undefined,
          true,
        )
      ) {
        return `${tempDir}/${this.projectName}`;
      }

      return undefined;
    } finally {
      process.chdir(startCwd);
    }
  }

  private async saveCachedVersion(
    version: string,
    toolPath: string,
  ): Promise<void> {
    const startCwd = process.cwd();

    try {
      const tempDir = this.getTemporaryName();
      await mkdir(tempDir);
      process.chdir(tempDir);
      await copyFile(toolPath, `${tempDir}/${this.projectName}`);

      await actionsCache.saveCache(
        [this.projectName],
        this.cacheKey(version),
        undefined,
        true,
      );
    } finally {
      process.chdir(startCwd);
    }
  }

  async fetch(): Promise<string> {
    actions_core.info(`Fetching from ${this.getUrl()}`);

    const versionCheckup = await gotClient.head(this.getUrl());
    if (versionCheckup.headers.etag) {
      const v = versionCheckup.headers.etag;

      actions_core.debug(
        `Checking the tool cache for ${this.getUrl()} at ${v}`,
      );
      const cached = await this.getCachedVersion(v);
      if (cached) {
        actions_core.debug(`Tool cache hit.`);
        return cached;
      }
    }

    actions_core.debug(
      `No match from the cache, re-fetching from the redirect: ${versionCheckup.url}`,
    );

    const destFile = this.getTemporaryName();

    await pipeline(
      gotClient.stream(versionCheckup.url),
      createWriteStream(destFile, {
        encoding: "binary",
        mode: 0o755,
      }),
    );

    if (versionCheckup.headers.etag) {
      const v = versionCheckup.headers.etag;

      await this.saveCachedVersion(v, destFile);
    }

    return destFile;
  }

  private getTemporaryName(): string {
    const _tmpdir = process.env["RUNNER_TEMP"] || tmpdir();
    return path.join(_tmpdir, `${this.projectName}-${uuidV4()}`);
  }
}

function getArchOs(): string {
  const envArch = process.env.RUNNER_ARCH;
  const envOs = process.env.RUNNER_OS;

  if (envArch && envOs) {
    return `${envArch}-${envOs}`;
  } else {
    actions_core.error(
      `Can't identify the platform: RUNNER_ARCH or RUNNER_OS undefined (${envArch}-${envOs})`,
    );
    throw new Error("RUNNER_ARCH and/or RUNNER_OS is not defined");
  }
}

function getNixPlatform(archOs: string): string {
  const archOsMap: Map<string, string> = new Map([
    ["X64-macOS", "x86_64-darwin"],
    ["ARM64-macOS", "aarch64-darwin"],
    ["X64-Linux", "X64-linux"],
    ["ARM64-Linux", "aarch64-linux"],
  ]);

  const mappedTo = archOsMap.get(archOs);
  if (mappedTo) {
    return mappedTo;
  } else {
    actions_core.error(
      `ArchOs (${archOs}) doesn't map to a supported Nix platform.`,
    );
    throw new Error(
      `Cannot convert ArchOs (${archOs}) to a supported Nix platform.`,
    );
  }
}

function constructSourceParameters(legacyPrefix?: string): SourceDef {
  const noisilyGetInput = (suffix: string): string | undefined => {
    const preferredInput = inputStringOrUndef(`source-${suffix}`);

    if (!legacyPrefix) {
      return preferredInput;
    }

    // Remaining is for handling cases where the legacy prefix
    // should be examined.
    const legacyInput = inputStringOrUndef(`${legacyPrefix}-${suffix}`);

    if (preferredInput && legacyInput) {
      actions_core.warning(
        `The supported option source-${suffix} and the legacy option ${legacyPrefix}-${suffix} are both set. Preferring source-${suffix}. Please stop setting ${legacyPrefix}-${suffix}.`,
      );
      return preferredInput;
    } else if (legacyInput) {
      actions_core.warning(
        `The legacy option ${legacyPrefix}-${suffix} is set. Please migrate to source-${suffix}.`,
      );
      return legacyInput;
    } else {
      return preferredInput;
    }
  };

  return {
    path: noisilyGetInput("path"),
    url: noisilyGetInput("url"),
    tag: noisilyGetInput("tag"),
    pr: noisilyGetInput("pr"),
    branch: noisilyGetInput("branch"),
    revision: noisilyGetInput("revision"),
  };
}

function inputStringOrUndef(name: string): string | undefined {
  const value = actions_core.getInput(name);
  if (value === "") {
    return undefined;
  } else {
    return value;
  }
}

async function main(): Promise<void> {
  let correlation: string = actions_core.getState("correlation");
  if (correlation === "") {
    correlation = `GH-${randomUUID()}`;
    actions_core.saveState("correlation", correlation);
  }

  const installer = new IdsToolbox(
    "magic-nix-cache-closure",
    "gh-env-style",
    correlation,
    "nix-installer",
  );

  actions_core.info(await installer.fetch());
}

await main();
