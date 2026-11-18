import React from "react";

import { useWorkspace } from "renderer/context/workspace";

type FocusTarget = React.RefObject<HTMLElement | null>;

interface FocusContextType {
  active: Element | null;
  targets: FocusTarget[];
}

interface FocusNode {
  parent: FocusNode | null;
  targets: FocusTarget[];
  initial?: FocusTarget;
  restore?: FocusTarget;
  delegate: FocusNode | null;
}

interface FocusProviderProps {
  targets?: FocusTarget[];
  initial?: FocusTarget;
  delegate?: boolean;
  children: React.ReactNode;
}

const editables = [HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement];

const styles: { [k: string]: React.CSSProperties } = {
  scope: {
    display: "contents",
  },
};

const FocusContext = React.createContext<FocusContextType>({
  active: null,
  targets: [],
});

const FocusNodeContext = React.createContext<FocusNode | null>(null);

const handled = new WeakSet<Event>();

let pressed = false;

export const useFocus = () => React.useContext(FocusContext);

export const FocusProvider: React.FC<FocusProviderProps> = ({ targets, initial, delegate, children }) => {
  const { active } = useWorkspace();
  const parent = React.useContext(FocusNodeContext);
  const context = React.useContext(FocusContext);
  const node = React.useRef<FocusNode>({ parent, targets: targets ?? [], delegate: null }).current;
  const [state, setState] = React.useState<FocusContextType>({
    active: null,
    targets: node.targets,
  });

  targets && (node.targets = targets);
  node.initial = initial;

  React.useEffect(() => {
    if (parent || !active) return;

    onDocumentFocusChange();
    fallback(node);
    document.addEventListener("focus", onDocumentFocusChange, true);
    document.addEventListener("blur", onDocumentFocusChange, true);

    return () => {
      document.removeEventListener("focus", onDocumentFocusChange, true);
      document.removeEventListener("blur", onDocumentFocusChange, true);
    };
  }, [active]);

  React.useEffect(() => {
    if (!parent || !delegate) return;

    parent.delegate = node;
    queueMicrotask(() => [document.body, ...parent.targets.map(target => target.current)].includes(document.activeElement as HTMLElement) && fallback(parent));

    return () => {
      parent.delegate === node && (parent.delegate = null);
      queueMicrotask(() => [document.body, ...node.targets.map(target => target.current)].includes(document.activeElement as HTMLElement) && fallback(parent));
    };
  }, [delegate]);

  function onDocumentFocusChange(e?: FocusEvent) {
    setState(state => ({ ...state, active: document.activeElement }));
    e?.type === "blur" && queueMicrotask(() => !pressed && document.activeElement === document.body && fallback(node));
  }

  function onMouse(e: React.MouseEvent) {
    pressed = e.type === "mousedown";

    if (handled.has(e.nativeEvent)) return;
    handled.add(e.nativeEvent);

    const active = document.activeElement;
    const target = node.targets.find(target => target.current === active);

    if (e.type === "mousedown") {
      node.restore = target;
      e.button === 0 && !e.shiftKey && window.getSelection()?.removeAllRanges();
    } else if (!target && !editables.some(type => active instanceof type) && !window.getSelection()?.toString()) {
      fallback(node, node.restore);
    }
  }

  return (
    <FocusContext.Provider value={{ active: parent ? context.active : state.active, targets: node.targets }}>
      <FocusNodeContext.Provider value={node}>
        <div style={styles.scope} onMouseDown={onMouse} onMouseUp={onMouse}>
          {children}
        </div>
      </FocusNodeContext.Provider>
    </FocusContext.Provider>
  );
};

function fallback(node: FocusNode, target = node.initial ?? node.targets[0]) {
  node.delegate ? fallback(node.delegate) : target?.current?.focus();
}
