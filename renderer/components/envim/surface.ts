import React from "react";

import { useWorkspace } from "renderer/context/workspace";

export function useSurface(editorInput: React.RefObject<HTMLInputElement | null>, browserTabCount: number) {
  const { active, emit } = useWorkspace();
  const [browser, setBrowser] = React.useState(false);
  const restoreEditorFocus = React.useRef(false);
  const previousTabs = React.useRef(browserTabCount);

  function focusEditor() {
    if (browser) {
      restoreEditorFocus.current = true;
      setBrowser(false);
    } else {
      editorInput.current?.focus();
    }
  }

  function toggle() {
    if (browser) {
      focusEditor();
      return;
    }
    if (!browserTabCount) void emit.send("browser:open", "");
    setBrowser(true);
  }

  React.useEffect(() => {
    if (browser && previousTabs.current > 0 && browserTabCount === 0) focusEditor();
    previousTabs.current = browserTabCount;
  }, [browserTabCount]);

  React.useLayoutEffect(() => {
    if (browser || !active || !restoreEditorFocus.current) return;
    restoreEditorFocus.current = false;
    editorInput.current?.focus();
  }, [active, browser]);

  React.useEffect(() => {
    const open = () => setBrowser(true);
    emit.on("browser:surface:show", open);
    return () => emit.off("browser:surface:show", open);
  }, []);

  return { browser, toggle, focusEditor };
}
