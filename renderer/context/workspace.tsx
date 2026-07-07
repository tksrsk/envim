import React from "react";

import { WorkspaceEmit } from "renderer/utils/emit";
import { Highlights } from "renderer/utils/highlight";
import { Canvas } from "renderer/utils/canvas";

interface WorkspaceContextType {
  workspace: string;
  workspaces: { [id: string]: string };
  active: boolean;
  emit: WorkspaceEmit;
  highlights: Highlights;
  canvas: Canvas;
}

const WorkspaceContext = React.createContext<WorkspaceContextType | null>(null);

export const WorkspaceProvider: React.FC<{ workspace: string; workspaces: { [id: string]: string }; active: boolean; emit: WorkspaceEmit; children: React.ReactNode }> = ({ workspace, workspaces, active, emit, children }) => {
  const highlights = React.useMemo(() => new Highlights(), []);
  const canvas = React.useMemo(() => new Canvas(highlights), [highlights]);

  React.useEffect(() => () => emit.dispose(), []);

  return (
    <WorkspaceContext.Provider value={{ workspace, workspaces, active, emit, highlights, canvas }}>
      {children}
    </WorkspaceContext.Provider>
  );
};

export function useWorkspace() {
  const ctx = React.useContext(WorkspaceContext);

  if (!ctx) {
    throw new Error("useWorkspace must be used inside WorkspaceProvider");
  }

  return ctx;
}
