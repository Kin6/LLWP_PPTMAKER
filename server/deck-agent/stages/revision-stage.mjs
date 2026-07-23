import { HttpError } from "../../shared/errors.mjs";
import { mergeQaEvidence as mergeQaEvidenceDefault } from "../verifier.mjs";

const SLIDE_ID = /^slide-\d{2}$/;
const SCOPES = new Set(["slides", "theme", "new-job-required"]);

function badRequest(message, options) {
  return new HttpError(400, message, options);
}

function conflict(message, options) {
  return new HttpError(409, message, options);
}

function manifestSlideIds(manifest) {
  const slideIds = manifest?.slides?.map((slide) => slide?.slideId);
  if (!Array.isArray(slideIds) || slideIds.length === 0
    || slideIds.some((slideId) => !SLIDE_ID.test(slideId))
    || new Set(slideIds).size !== slideIds.length) {
    throw new Error("Revision manifest has invalid slide identities");
  }
  return slideIds;
}

export function resolveExplicitTargets({ slideIds, currentSlideId }, manifest) {
  const orderedSlideIds = manifestSlideIds(manifest);
  const known = new Set(orderedSlideIds);
  const requested = slideIds?.length ? [...new Set(slideIds)] : currentSlideId ? [currentSlideId] : [];
  if (requested.some((slideId) => !known.has(slideId))) throw badRequest("Edit references an unknown slide");
  if (requested.length === 0) throw badRequest("An edit requires the current slide or explicit slide IDs");
  const selected = new Set(requested);
  return orderedSlideIds.filter((slideId) => selected.has(slideId));
}

function validatedClassification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !SCOPES.has(value.scope)
    || !Array.isArray(value.slideIds) || value.slideIds.some((slideId) => !SLIDE_ID.test(slideId))) {
    throw new Error("Revision classifier returned an invalid edit scope");
  }
  return { scope: value.scope, slideIds: [...new Set(value.slideIds)] };
}

export function resolveEditScope(request, classificationOrManifest, explicitManifest) {
  const manifest = explicitManifest || classificationOrManifest;
  const classification = validatedClassification(explicitManifest
    ? classificationOrManifest
    : request?.classification || { scope: "slides", slideIds: [] });
  if (classification.scope === "new-job-required") {
    throw conflict("A narrative rewrite requires a new job");
  }

  if (request?.slideIds?.length) {
    const slideIds = resolveExplicitTargets({ slideIds: request.slideIds }, manifest);
    return { classification: { ...classification, scope: "slides", slideIds }, slideIds };
  }
  if (classification.scope === "theme") {
    return { classification, slideIds: manifestSlideIds(manifest) };
  }
  const slideIds = resolveExplicitTargets({
    slideIds: classification.slideIds,
    currentSlideId: request?.currentSlideId,
  }, manifest);
  return { classification: { ...classification, slideIds }, slideIds };
}

function validateChangedFiles(changedFiles, { classification, slideIds }) {
  if (!Array.isArray(changedFiles)) throw new Error("Revision patch must report changed files");
  const allowedSlides = new Set(slideIds);
  for (const relativePath of changedFiles) {
    if (classification.scope === "theme") {
      if (relativePath !== "theme.css") throw new Error("Theme revisions may change only theme.css");
      continue;
    }
    const slide = /^slides\/(slide-\d{2})\.(?:html|css)$/.exec(relativePath);
    if (slide && allowedSlides.has(slide[1])) continue;
    if (/^assets\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/.test(relativePath)) continue;
    throw new Error("Slide revision changed a file outside its requested targets");
  }
  return [...new Set(changedFiles)];
}

export async function runRevisionStage(context, request) {
  if (!context?.revisions?.readCurrent || typeof context.classifyInstruction !== "function"
    || typeof context.patchCandidate !== "function" || !context.verifier?.verify) {
    throw new TypeError("Revision stage dependencies are incomplete");
  }
  context.signal?.throwIfAborted();
  const current = await context.revisions.readCurrent(context.jobId);
  if (request?.expectedRevision !== current.number) {
    throw conflict("Deck revision changed; reload before editing");
  }
  const manifest = await context.readRevisionManifest(current.number, current);
  const classified = validatedClassification(await context.classifyInstruction(request, manifest));
  const { classification, slideIds } = resolveEditScope(request, classified, manifest);
  context.signal?.throwIfAborted();

  const candidate = await context.revisions.createCandidate(context.jobId, {
    parentRevision: current.number,
    instruction: request.instruction,
    scope: classification.scope,
    slideIds,
  }, { signal: context.signal });
  try {
    const patchResult = await context.patchCandidate(candidate, {
      request,
      slideIds,
      classification,
      signal: context.signal,
    });
    const changedFiles = validateChangedFiles(patchResult?.changedFiles || [], { classification, slideIds });
    context.signal?.throwIfAborted();
    const dom = await context.verifier.verify({
      jobId: context.jobId,
      revisionId: candidate.revisionId,
      slideIds,
      captureContactSheet: true,
      signal: context.signal,
    });
    const visual = await context.reviewCandidate({
      candidate,
      slideIds,
      instruction: request.instruction,
      contactSheetArtifactId: dom.contactSheetArtifactId,
      screenshotArtifactIds: dom.slides.map((slide) => slide.screenshotArtifactId).filter(Boolean),
      maxUpstreamCalls: 1,
      signal: context.signal,
    });
    const mergeQaEvidence = context.mergeQaEvidence || mergeQaEvidenceDefault;
    const qa = mergeQaEvidence(dom, visual);
    await context.revisions.recordQa(context.jobId, candidate.number, qa, { changedFiles });
    if (!qa.ok) throw conflict("Candidate revision failed QA");
    context.signal?.throwIfAborted();
    await context.renderCandidate(candidate, { signal: context.signal });
    context.signal?.throwIfAborted();
    return await context.revisions.publishCandidate(context.jobId, candidate.number, {
      expectedRevision: current.number,
      signal: context.signal,
    });
  } catch (error) {
    await context.revisions.discardCandidate(context.jobId, candidate.number, error).catch(() => {});
    throw error;
  }
}
