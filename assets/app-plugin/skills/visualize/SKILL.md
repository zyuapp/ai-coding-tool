---
name: visualize
description: Draw an interactive visual inline in your reply (chart, plot, diagram, simulation, calculator, timeline, or side-by-side comparison) as HTML, CSS, and JavaScript in a `visual` code block. Use when seeing or adjusting something explains it better than prose or a table, or when the user asks to visualize, chart, plot, or show how something works.
---

# Visualize

AICodingTool renders a fenced code block whose language is `visual` as a live frame inside your reply. The frame fills the message width and grows to the height of its content. Clients that cannot render it show the source, so state the takeaway in prose as well.

## When to use it

- Use it for data with a shape (distributions, trends, comparisons), how a system or algorithm behaves, "what happens if" questions with parameters to adjust, and options weighed side by side.
- Skip it when a sentence, a list, or a Markdown table says the same thing.
- Use a `mermaid` block instead for a plain flowchart, sequence, or state diagram.
- A visual explains something in the conversation. When the user wants a page, report, or app as a deliverable, write files instead.

## Format

````
```visual
<div id="viz-retry-backoff">
  <style>
    #viz-retry-backoff { display: grid; gap: 12px; }
  </style>
  ...markup...
  <script>
    const root = document.getElementById("viz-retry-backoff");
    ...
  </script>
</div>
```
````

- Write an HTML fragment: no `<!doctype>`, `<html>`, `<head>`, or `<body>`.
- Wrap everything in one root element with a unique, descriptive `id`, and scope every CSS rule under it.
- Put `<style>` and `<script>` inside the fragment. Scripts run in document order once the markup is in the page. `DOMContentLoaded` has already fired, so do not wait for it.
- Close the fence. If the HTML itself contains three backticks, open and close the block with four.
- Keep it under about 100 KB. Over 1 MB it is shown as code.

## The sandbox

The frame has its own origin and no network. Anything that needs either fails.

- Everything is inline. No `<script src>`, external stylesheets, web fonts, remote images, or iframes. Draw with SVG, canvas, or CSS; embed small images as `data:` URIs.
- No libraries are available. Write plain JavaScript.
- No `fetch`, XHR, WebSocket, or other network calls. Put the data in the script.
- No `localStorage`, `sessionStorage`, cookies, or IndexedDB: they throw. Keep state in variables.
- No `alert`, `confirm`, `prompt`, clipboard, popups, downloads, form submission, or navigation. Links do nothing, so leave out copy buttons and links.
- A visual restarts when it scrolls far out of view and back, or when the app restarts.

## Theme

The app sets these custom properties on the frame's root and updates them when the user changes theme or font. Use them for every color and font, so the visual matches the app in light and dark themes. Never hard-code a palette; derive tints with `color-mix(in srgb, var(--series-1) 20%, transparent)`.

| Property | Use |
|---|---|
| `--color-bg` | The conversation's background, for knockouts and gaps |
| `--color-surface` | Cards and panels set on the background |
| `--color-surface-raised` | Something set on a card: chips, the selected segment |
| `--color-surface-hover` | Hover on a control or row |
| `--color-text` | Primary text |
| `--color-text-secondary` | Labels, axis text, captions |
| `--color-text-tertiary` | Hints, placeholders, disabled text |
| `--color-border` | Dividers, card borders, gridlines |
| `--color-border-strong` | Input borders, axes |
| `--color-accent`, `--color-on-accent` | The one emphasized element, and text on it |
| `--color-success`, `--color-warning`, `--color-danger`, `--color-info` | Status only |
| `--series-1` … `--series-6` | Categorical data colors, in this order |
| `--font-sans`, `--font-mono`, `--font-size` | The reply's own type; numbers and code in mono |
| `--radius` | Corner radius for cards and controls |

The body already uses `--color-text` and `--font-sans` at `--font-size`, and native controls follow the theme and accent color. When script draws colors into canvas or SVG attributes, read them at draw time with `getComputedStyle(document.documentElement).getPropertyValue("--series-1")` and redraw on the window's `visualthemechange` event.

## Layout

- Leave the outermost background transparent so the visual sits on the conversation like prose. Use `--color-surface` cards only to group things.
- Fill the width and adapt from 320px to about 1000px: no fixed widths, use flex or grid with wrapping, and give SVG a `viewBox` with `width: 100%`.
- Let content set the height. Never use `vh` units or percentage heights on the root, and keep the whole visual under about 800px tall.
- Keep text at 12px or larger.

## Quality bar

- One idea per visual. Give it a short title, label axes with units, and prefer direct labels to a legend.
- Make interaction obvious: native `<input type="range">`, `<select>`, and `<button>` controls with visible labels, the current value shown beside each slider, and hover details that also appear on focus.
- Animate with `requestAnimationFrame`, and honour `prefers-reduced-motion`.
- Before sending, check that every element the script queries exists, every identifier is defined, and nothing throws. The app shows the first script error under the visual.
- After the block, add one to three sentences on what the visual shows or what to try.
