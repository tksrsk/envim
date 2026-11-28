import React from "react";

import { useApp } from "renderer/context/app";
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

export const WorkspaceProvider: React.FC<{ workspace: string; workspaces: { [id: string]: string }; active: boolean; workspaceId: string; children: React.ReactNode }> = ({ workspace, workspaces, active, workspaceId, children }) => {
  const { setting: { opacity, options } } = useApp();
  const emit = React.useMemo(() => new WorkspaceEmit(workspaceId), [workspaceId]);
  const [highlights] = React.useState(() => new Highlights(opacity, options.ext_multigrid));

  const canvas = React.useMemo(() => new Canvas(highlights), [highlights]);

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
