// Tiny DOM helpers (no framework).

import { scale2x } from '../render/hd.js';

/**
 * h('div.card#id', { onclick, style, ...attrs }, ...children)
 * Children may be strings, nodes, arrays, or null/false (skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1));
    else if (part.startsWith('#')) el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val === undefined || val === null) continue;
        // Custom properties (--rarity) need setProperty; Object.assign drops them.
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Wraps a canvas so CSS can scale it crisply (a smoothed 2× copy, like the game world). */
export function pixelCanvas(canvas, size) {
  let c;
  try {
    c = scale2x(canvas);
  } catch {
    c = document.createElement('canvas');
    c.width = canvas.width * 2;
    c.height = canvas.height * 2;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(canvas, 0, 0, c.width, c.height);
  }
  c.className = 'pixel';
  if (size) {
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
  } else {
    // The copy has twice the pixels: show it at the original's size.
    c.style.width = `${canvas.width}px`;
  }
  return c;
}
