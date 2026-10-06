export const packageTargets = [
  {
    platform: "linux",
    arch: "x64",
    app: "linux/linux-unpacked",
    exe: "agentvac",
    kind: "elf",
  },
  {
    platform: "windows",
    arch: "x64",
    app: "windows/win-unpacked",
    exe: "AgentVac.exe",
    kind: "pe",
  },
  {
    platform: "macos",
    arch: "x64",
    app: "macos/mac/AgentVac.app/Contents",
    exe: "MacOS/AgentVac",
    kind: "macho",
  },
  {
    platform: "macos",
    arch: "arm64",
    app: "macos/mac-arm64/AgentVac.app/Contents",
    exe: "MacOS/AgentVac",
    kind: "macho",
  },
];

export function selectPackageTargets(platform, arch) {
  if (
    platform !== undefined &&
    !["linux", "windows", "macos"].includes(platform)
  )
    throw new Error("Unknown package platform filter");
  if (arch !== undefined && !["x64", "arm64"].includes(arch))
    throw new Error("Unknown package architecture filter");
  if (arch !== undefined && platform === undefined)
    throw new Error("An architecture filter requires an explicit platform");
  const selected = packageTargets.filter(
    (target) =>
      (!platform || target.platform === platform) &&
      (!arch || target.arch === arch),
  );
  if (!selected.length)
    throw new Error("Unsupported package platform and architecture");
  return selected;
}
