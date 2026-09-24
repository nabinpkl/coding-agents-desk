const assert = require("node:assert/strict");
const { buildMarkdown } = require("../format.js");

const annotations = [
  {
    text: "Submit button padding is off on mobile",
    metadata: {
      tagName: "BUTTON",
      selector: "form > button.btn-primary",
      fullPath: "body > div#app > form > button",
      classes: "btn btn-primary",
      text: "Submit",
      component: "SubmitButton",
      bbox: { x: 320, y: 480, width: 120, height: 32 },
      styles: "color:#fff bg:#3b82f6",
      tag: "bug"
    }
  },
  { text: "Hero needs more spacing", metadata: { tagName: "SECTION", selector: "main > section.hero", tag: "suggestion" } }
];

const md = buildMarkdown(annotations, { url: "https://example.com/form", title: "Form" });
assert.ok(md.includes("# Annotate Export"));
assert.ok(md.includes("**Items:** 2"));
assert.ok(md.includes("form > button.btn-primary"));
assert.ok(md.includes("Submit button padding is off"));
assert.ok(md.includes("body > div#app > form > button"));
assert.ok(md.includes("main > section.hero"));

const empty = buildMarkdown([], { url: "https://example.com/", title: "Home" });
assert.ok(empty.includes("**Items:** 0"));

console.log("brief.test.js ok");
