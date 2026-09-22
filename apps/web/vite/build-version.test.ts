import path from "node:path";
import rootPackageJson from "../../../package.json";
import { describe, expect, it } from "vitest";
import { resolveClientBuildVersion } from "./build-version";

const repoRoot = path.resolve(process.cwd(), "../..");

describe("resolveClientBuildVersion", () => {
  it("uses the workspace package version when build env is absent", () => {
    expect(resolveClientBuildVersion(repoRoot, {})).toBe(rootPackageJson.version);
  });

  it("hides dev placeholders behind the stable package version", () => {
    expect(resolveClientBuildVersion(repoRoot, { RENEWLET_VERSION: "0.0.0-dev" })).toBe(rootPackageJson.version);
    expect(resolveClientBuildVersion(repoRoot, { RENEWLET_VERSION: `${rootPackageJson.version}-dev` })).toBe(rootPackageJson.version);
  });

  it("keeps explicit release and branch build versions", () => {
    expect(resolveClientBuildVersion(repoRoot, { RENEWLET_VERSION: "0.2.0-rc.1" })).toBe("0.2.0-rc.1");
    expect(resolveClientBuildVersion(repoRoot, { VITE_RENEWLET_VERSION: "0.2.0-dev+504c168" })).toBe("0.2.0-dev+504c168");
  });
});
