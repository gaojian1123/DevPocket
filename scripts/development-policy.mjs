// Local execution trust is not a CI impact rule or a record of human approval.
export const isVerificationPolicyPath = (file) =>
  /^(?:\.github\/|scripts\/|AGENTS\.md$|android\/gradle\/|android\/gradlew(?:\.bat)?$)/i.test(file) ||
  /(?:^|\/)\.npmrc$/i.test(file) ||
  /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[^/]+)?\.json|requirements[^/]*\.txt)$/i.test(file) ||
  /^android\/.*(?:\.gradle(?:\.kts)?|gradle\.properties)$/i.test(file);

function requiresReview(file) {
  if (isVerificationPolicyPath(file)) return true;
  if (["README.md", "VALIDATION.md"].includes(file) || /^docs\/.*\.md$/.test(file)) return false;
  if (file.startsWith("android/")) return /\/data\/|Manifest|\.gradle|gradle\.properties/.test(file);
  if (file.startsWith("backend/")) return file.startsWith("backend/src/");
  return true;
}

export function developmentReviewRequirements(changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.some((file) => typeof file !== "string" || !file.length)) {
    throw new TypeError("Development review requires the actual changed-path list.");
  }
  const files = [...new Set(changedFiles)].sort();
  return {
    requiresHumanReview: files.some(requiresReview),
    protectedPaths: files.filter(isVerificationPolicyPath),
  };
}
