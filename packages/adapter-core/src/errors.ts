export class AdapterValidationError extends Error {
  readonly issues: string[];

  constructor(kind: "manifest" | "lock", issues: string[]) {
    super(`Invalid adapter ${kind}:\n- ${issues.join("\n- ")}`);
    this.name = "AdapterValidationError";
    this.issues = issues;
  }
}
