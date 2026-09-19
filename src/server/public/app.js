// Entry point: collect the DOM handles the HUD needs, then start it.
import { Hud } from "./hud.js";

const $ = (id) => document.getElementById(id);

const hud = new Hud({
  transcript: $("transcript"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  modelName: $("model-name"),
  modelVia: $("model-via"),
  toolrail: $("toolrail"),
  toolList: $("tool-list"),
  toolCount: $("tool-count"),
  toolEmpty: $("tool-empty"),
  liveDot: $("live-dot"),
  clock: $("clock"),
  scanBar: $("scan-bar"),
  hil: $("hil"),
  hilReason: $("hil-reason"),
  hilCode: $("hil-code"),
  hilApprove: $("hil-approve"),
  hilAbort: $("hil-abort"),
});

hud.init();
window.__carter = hud;
