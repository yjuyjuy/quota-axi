import {
  compareModelsByRunway,
  decide,
  type DecideRequest,
  type DecisionResponse,
  type ModelQuotaRecord,
  type ModelsResponse,
  type QuotaAxiResponse,
} from "quota-axi";

const quota: QuotaAxiResponse = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  schemaVersion: 3,
  providers: [],
};

const model: ModelQuotaRecord = {
  provider: "claude",
  id: "consumer-fixture",
  label: "Consumer fixture",
  intelligence: "high",
  quotaScopes: [],
  state: { status: "fresh", stale: false },
};

const models: ModelsResponse = {
  generatedAt: quota.generatedAt,
  schemaVersion: 1,
  catalog: { version: "2026-08-05", provenance: "consumer fixture" },
  models: [model],
};

void models;
void compareModelsByRunway(model, model);

const decideRequest: DecideRequest = {
  registry: { schema_version: 1, accounts: [] },
  policy: { schema_version: 1, tiers: [] },
  observations: {},
  now: quota.generatedAt,
};
const decision: DecisionResponse = decide(decideRequest);
void decision.decisions;
