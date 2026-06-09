import React from "react";

const getKey = (key: string, e: React.KeyboardEvent, wrap: boolean) => {
  const { ctrlKey, altKey, metaKey, shiftKey } = e;
  if (ctrlKey) return `<C-${key}>`;
  if (altKey) return `<A-${key}>`;
  if (metaKey) return `<D-${key}>`;
  if (wrap) return shiftKey ? `<S-${key}>` : `<${key}>`;
  return key;
};

export const keycode = (e: React.KeyboardEvent) => {
  const { keyCode, key, ctrlKey } = e;

  switch (key) {
    case "¥": return "\\";
    case "<": return "<LT>";
    case "Escape": return getKey("Esc", e, true);
    case "Backspace": return getKey("BS", e, true);
    case "Insert": return getKey("Insert", e, true);
    case "Delete": return getKey("Del", e, true);
    case "Tab": return getKey("Tab", e, true);
    case "Enter": return getKey("CR", e, true);
    case "ArrowUp": return getKey("Up", e, true);
    case "ArrowDown": return getKey("Down", e, true);
    case "ArrowLeft": return getKey("Left", e, true);
    case "ArrowRight": return getKey("Right", e, true);
    case "Home": return getKey("Home", e, true);
    case "End": return getKey("End", e, true);
    case "PageUp": return getKey("PageUp", e, true);
    case "PageDown": return getKey("PageDown", e, true);
    case "Help": return getKey("Help", e, true);
    case "F1": return getKey("F1", e, true);
    case "F2": return getKey("F2", e, true);
    case "F3": return getKey("F3", e, true);
    case "F4": return getKey("F4", e, true);
    case "F5": return getKey("F5", e, true);
    case "F6": return getKey("F6", e, true);
    case "F7": return getKey("F7", e, true);
    case "F8": return getKey("F8", e, true);
    case "F9": return getKey("F9", e, true);
    case "F10": return getKey("F10", e, true);
    case "F11": return getKey("F11", e, true);
    case "F12": return getKey("F12", e, true);
  }

  if (keyCode === 229 || key.length > 1) return "";
  if (ctrlKey && key === "|") return getKey("\\", e, true);

  return getKey(key, e, false);
};
