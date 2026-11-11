// Waits for TestFlight to finish processing build BUILD_NUMBER, adds it to the GROUP_NAME beta group,
// and submits it for beta review unless it was already submitted or another build of its version is in review.
import { createPrivateKey, createSign } from "node:crypto";

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, APP_ID, GROUP_NAME, BUILD_NUMBER } = process.env;
if (!BUILD_NUMBER) throw new Error("BUILD_NUMBER is not set.");
const key = createPrivateKey(Buffer.from(ASC_KEY_P8, "base64"));
const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" })}.${part({ iss: ASC_ISSUER_ID, iat: now, exp: now + 900, aud: "appstoreconnect-v1" })}`;
  return `${unsigned}.${createSign("SHA256").update(unsigned).sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// A fresh upload is listed only after App Store Connect starts processing it.
let build;
for (let attempt = 0; attempt < 90; attempt += 1) {
  const found = await api("GET", `/v1/builds?filter[app]=${APP_ID}&filter[version]=${BUILD_NUMBER}&limit=1&fields[builds]=version,processingState`);
  build = found.body?.data?.[0];
  const state = build?.attributes.processingState;
  if (state === "VALID") break;
  if (state === "FAILED" || state === "INVALID") throw new Error(`Build ${BUILD_NUMBER} is ${state}.`);
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}
if (build?.attributes.processingState !== "VALID") throw new Error(`Build ${BUILD_NUMBER} did not finish processing in time.`);
console.log(`Build ${BUILD_NUMBER} is ready.`);

const groups = await api("GET", `/v1/betaGroups?filter[app]=${APP_ID}&filter[name]=${encodeURIComponent(GROUP_NAME)}`);
const group = groups.body?.data?.[0];
if (!group) throw new Error(`No TestFlight group named ${GROUP_NAME}.`);

const notes = await api("POST", "/v1/betaBuildLocalizations", {
  data: { type: "betaBuildLocalizations", attributes: { locale: "en-US", whatsNew: "Matches the latest AI Coding Tool release for your computer." }, relationships: { build: { data: { type: "builds", id: build.id } } } },
});
if (notes.status >= 400 && notes.status !== 409) throw new Error(`Test notes: ${JSON.stringify(notes.body)}`);

const added = await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
if (added.status >= 400) throw new Error(`Adding to ${GROUP_NAME}: ${JSON.stringify(added.body)}`);

// Only a build nobody has submitted yet is sent for review; one already waiting, in review or live is left as it is.
const detail = await api("GET", `/v1/builds/${build.id}/buildBetaDetail`);
const external = detail.body?.data?.attributes.externalBuildState;
if (external !== "READY_FOR_BETA_SUBMISSION") {
  console.log(`Sent to ${GROUP_NAME}; beta review is ${external}.`);
} else {
  const submitted = await submit();
  // Apple reviews one build of a version at a time; a build already in the queue keeps its place.
  if (anotherInReview(submitted)) {
    console.log(`::notice::Build ${BUILD_NUMBER} is in ${GROUP_NAME} but not sent for beta review: another build of this version is already in review.`);
  } else {
    if (submitted.status >= 400) throw new Error(`Beta review: ${JSON.stringify(submitted.body)}`);
    console.log(`Sent to ${GROUP_NAME}; beta review is ${submitted.body.data.attributes.betaReviewState}.`);
  }
}

function submit() {
  return api("POST", "/v1/betaAppReviewSubmissions", {
    data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } },
  });
}

function anotherInReview(response) {
  return response.status === 422 && response.body?.errors?.some((error) => error.code === "ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW");
}
