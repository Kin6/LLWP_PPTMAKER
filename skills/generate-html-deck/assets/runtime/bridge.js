const channelToken = new URLSearchParams(location.hash.slice(1)).get("channel") || "";
if (!/^[A-Za-z0-9_-]{22}$/.test(channelToken)) throw new Error("Invalid preview channel");
const bridge = Object.freeze({ jobId: "__JOB_ID__", revision: __REVISION__, channelToken });

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.origin !== "__PARENT_ORIGIN__") return;
  const message = event.data;
  if (!message
    || message.type !== "deck-command"
    || message.channelToken !== bridge.channelToken
    || message.jobId !== bridge.jobId
    || message.revision !== bridge.revision) return;
  if (message.command !== "go-to-slide"
    || !Number.isSafeInteger(message.index)
    || message.index < 0
    || typeof message.slideId !== "string") return;
  if (document.querySelector(`[data-slide-id="${CSS.escape(message.slideId)}"]`)) Reveal.slide(message.index);
});
Reveal.on("slidechanged", (event) => {
  parent.postMessage({
    type: "deck-slide-changed",
    channelToken: bridge.channelToken,
    jobId: bridge.jobId,
    revision: bridge.revision,
    slideId: event.currentSlide?.querySelector("[data-slide-id]")?.dataset.slideId || "",
  }, "__PARENT_ORIGIN__");
});
