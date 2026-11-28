import React from "react";
import { ActionIcon, Box, Loader } from "@mantine/core";

import { WorkspaceTabComponent } from "renderer/components/tab";
import { useWorkspace } from "renderer/context/workspace";
import { uiIcons } from "renderer/utils/icons";
import type { BrowserWorkspace } from "renderer/context/browser";

function TabFavicon({ src }: { src?: string }) {
  const [failed, setFailed] = React.useState(false);
  return src && !failed
    ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}
        style={{ width: "1em", height: "1em", flexShrink: 0, objectFit: "contain" }} />
    : <i>󰖟</i>;
}

export function BrowserTablineComponent({ state }: { state: BrowserWorkspace }) {
  const { emit } = useWorkspace();
  return (
    <>
      <div style={{ display: "flex", minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
        {state.tabs.map(tab => {
          const active = state.selected === tab.id;
          const shared = tab.shared;
        const title = tab.title || "New tab";
          const select = () => void emit.send("browser:tabs:select", tab.id);
          const close = () => void emit.send("browser:tabs:close", tab.id);
          return (
            <WorkspaceTabComponent key={tab.id} active={active} font="󰖟" text={title}
              title={shared ? `${title} (shared with the agent)` : title}
              glyph={tab.loading ? <Loader size="1em" /> : <TabFavicon key={tab.favicon} src={tab.favicon} />}
              badge={shared && <Box component="i" c="violet">{uiIcons.agent}</Box>}
              onClick={select}
              onClose={event => { event.stopPropagation(); close(); }} />
          );
        })}
      </div>
      <ActionIcon color="green" onClick={() => void emit.send("browser:open", "")}><i>{uiIcons.add}</i></ActionIcon>
    </>
  );
}
