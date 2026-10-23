import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureCandidateImplementation, requireCandidateImplementation } from "./native-candidate.mjs";

export async function freezeDevelopmentController(root, original) {
  await requireCandidateImplementation(original);
  const parent = path.join(root, ".data", "development-controllers");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "approved-"));
  for (const input of original.files) {
    await mkdir(path.dirname(path.join(directory, input.name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, input.name), await readFile(path.join(original.directory, input.name)),
      { flag: "wx", mode: 0o400 });
  }
  await requireCandidateImplementation(original);
  const frozen = await captureCandidateImplementation(directory);
  if (JSON.stringify(frozen.files) !== JSON.stringify(original.files)) {
    throw new Error("The approved development controller changed while its immutable snapshot was prepared.");
  }
  return { directory, implementation: frozen };
}
