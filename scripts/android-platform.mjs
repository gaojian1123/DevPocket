export const androidImagePattern = /^system-images[\\/]android-\d+(?:\.\d+)?[\\/](?:google_apis(?:_playstore)?|default)[\\/](x86_64|arm64-v8a)$/;

export function androidImageArchitecture(platform = process.platform, architecture = process.arch) {
  if (platform === "darwin" && architecture === "arm64") return "arm64-v8a";
  if (architecture === "x64" && ["win32", "linux", "darwin"].includes(platform)) return "x86_64";
  throw new Error("The native gate requires an x64 host or an Apple Silicon Mac.");
}

export function macOSAcceleration(output) {
  const records = [...output.matchAll(/^accel:\s*\r?\n(\d+)\r?\n([^\r\n]+)\r?\naccel[ \t]*$/gm)];
  if (records.length !== 1 || records[0][1] !== "0" ||
      !/^Hypervisor\.Framework\b/.test(records[0][2])) {
    throw new Error("The macOS device gate requires explicit usable Hypervisor.Framework acceleration.");
  }
  return { provider: "HVF", usable: true };
}
