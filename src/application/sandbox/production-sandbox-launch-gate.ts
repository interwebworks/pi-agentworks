import type {
  SandboxCapabilityDoctor,
  SandboxCapabilityReport,
} from "../ports/sandbox-capability-doctor.ts";

export class ProductionSandboxUnavailableError extends Error {
  readonly report: SandboxCapabilityReport;

  constructor(report: SandboxCapabilityReport) {
    super(
      `Production sandbox is unavailable:\n- ${report.reasons.length > 0 ? report.reasons.join("\n- ") : "capability evidence is incomplete"}`,
    );
    this.name = "ProductionSandboxUnavailableError";
    this.report = report;
  }
}

export class ProductionSandboxLaunchGate {
  readonly #doctor: SandboxCapabilityDoctor;

  constructor(doctor: SandboxCapabilityDoctor) {
    this.#doctor = doctor;
  }

  assertAvailable(): SandboxCapabilityReport {
    const report = this.#doctor.inspect();
    if (
      !report.supported ||
      report.evidence === null ||
      report.probes.length === 0 ||
      report.probes.some((probe) => !probe.passed)
    ) {
      throw new ProductionSandboxUnavailableError(report);
    }
    return report;
  }
}
