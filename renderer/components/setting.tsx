import React from "react";
import { Box, Button, Checkbox, Group, Paper, Radio, ScrollArea, SegmentedControl, SimpleGrid, Slider, Stack, Text, TextInput, Title } from "@mantine/core";

import { ISetting } from "common/interface";

import { Emit } from "renderer/utils/emit";
import { Setting } from "renderer/utils/setting";

const envimIconUrl = new URL("../../assets/envim-icon.png", import.meta.url).href;

interface Props {
  width: number;
  height: number;
}

const connectionLabels = [
  { value: "command", label: "Command" },
  { value: "address", label: "Server" },
  { value: "docker", label: "Docker" },
  { value: "ssh", label: "SSH" },
];

export function SettingComponent (props: Props) {
  const [state, setState] = React.useState<ISetting>({...Setting.get() });

  React.useEffect(() => {
    Emit.on("app:setting", onAppSetting);
    Emit.send("app:init");

    return () => {
      Emit.off("app:setting", onAppSetting);
    };
  }, []);

  function onAppSetting (state: ISetting) {
    setState(() => state);
  }

  function onChangeConnection (type: ISetting["type"], path: string) {
    setState(state => {
      const { presets, searchengines, ...rest } = state.presets[`[${type}]:${path}`] || { type, path };

      return { ...state, ...rest };
    });
  }

  function onChangeFont (font: Partial<ISetting["font"]>) {
    setState(state => ({ ...state, font: { ...state.font, ...font } }));
  }

  function onToggleOption (name: string, checked: boolean) {
    setState(state => ({ ...state, options: { ...state.options, [name]: checked } }));
  }

  function onSelectBookmark(index: number) {
    setState(state => ({
      ...state,
      bookmarks: state.bookmarks.map((bookmark, i) => ({ ...bookmark, selected: i === index }))
    }));
  }

  function onSelectPreset(key: string) {
    setState(({ searchengines, presets, ...state }) => ({ ...state, ...presets[key], searchengines, presets }));
  }

  function onSubmit (e: React.FormEvent) {
    const { type, path, font, opacity, options, bookmarks, searchengines, acp } = state;

    e.stopPropagation();
    e.preventDefault();

    Setting.type = type;
    Setting.path = path;
    Setting.font = { size: font.size, width: Math.floor(font.size * 0.6), height: font.size + font.lspace, lspace: font.lspace, scale: Math.ceil(window.devicePixelRatio) };
    Setting.opacity = opacity;
    Setting.options = options;
    Setting.bookmarks = bookmarks;
    Setting.searchengines = searchengines;
    Setting.acp = acp;

    Emit.send("neovim:connect", Setting.get(), bookmarks.find(({ selected }) => selected)?.path);
  }

  function renderSection(title: string, description: string, children: React.ReactNode, span = 1) {
    return (
      <Paper withBorder radius="md" p="lg" style={{ gridColumn: `span ${span}` }}>
        <Title order={2} size="h4">{title}</Title>
        <Text size="sm" c="dimmed" mb="md">{description}</Text>
        {children}
      </Paper>
    );
  }

  function renderSlider(label: string, value: number, unit: string, min: number, max: number, onChange: (value: number) => void) {
    return (
      <Box mb="md">
        <Group justify="space-between" mb={4}>
          <Text size="sm" fw={500}>{label}</Text>
          <Text size="sm" c="dimmed">{value}{unit}</Text>
        </Group>
        <Slider min={min} max={max} value={value} onChange={onChange} label={null} />
      </Box>
    );
  }

  const selectedBookmark = state.bookmarks.findIndex(({ selected }) => selected);

  return (
    <ScrollArea style={props}>
      <Box pos="fixed" inset={0} bg="var(--mantine-color-body)" style={{ zIndex: -1, pointerEvents: "none", opacity: (100 - state.opacity) / 100 }} />
      <form style={{ maxWidth: 880, margin: "0 auto", padding: "48px 28px 28px" }} onSubmit={onSubmit}>
        <Group gap={18} mb={28} wrap="nowrap">
          <img src={envimIconUrl} alt="" width={56} height={56} draggable={false} />
          <div>
            <Text size="xs" fw={600} c="blue" style={{ letterSpacing: ".16em" }}>YOUR NEOVIM WORKSPACE</Text>
            <Title order={1} size={27}>Welcome to Envim</Title>
          </div>
        </Group>

        <SimpleGrid cols={2} spacing="md">
          {renderSection("Connection", "Choose how to connect to Neovim.", <Stack>
            <SegmentedControl data={connectionLabels} value={state.type} onChange={type => onChangeConnection(type as ISetting["type"], state.path)} style={{ alignSelf: "flex-start" }} />
            <TextInput label="Neovim path" value={state.path} onChange={e => onChangeConnection(state.type, e.currentTarget.value)} autoFocus spellCheck={false} />
          </Stack>, 2)}

          {renderSection("Appearance", "Fine-tune your editor’s reading comfort.", <>
            {renderSlider("Font size", state.font.size, "px", 5, 20, size => onChangeFont({ size }))}
            {renderSlider("Line spacing", state.font.lspace, "px", 0, 10, lspace => onChangeFont({ lspace }))}
            <Paper bg="var(--mantine-color-default)" p="sm" mb="md">
              <Text size="xs" c="dimmed" mb={8} style={{ letterSpacing: ".12em" }}>PREVIEW</Text>
              <div style={{ fontFamily: "var(--mantine-font-family-monospace)", overflowWrap: "anywhere", fontSize: state.font.size, lineHeight: `${state.font.size + state.font.lspace}px` }}>
                The quick brown fox<br />
                jumps over the lazy dog.
              </div>
            </Paper>
            {renderSlider("Transparency", state.opacity, "%", 0, 50, opacity => setState(state => ({ ...state, opacity })))}
          </>)}

          {renderSection("Options", "Choose the Neovim UI features to enable.", <Stack gap="xs">
            {Object.keys(state.options).map(key => (
              <Checkbox key={key} label={key} checked={state.options[key]} onChange={e => onToggleOption(key, e.currentTarget.checked)} ff="monospace" />
            ))}
          </Stack>)}

          {renderSection("Bookmarks", "Pick a workspace to open.", <ScrollArea.Autosize mah={180}>
            <Radio.Group value={`${selectedBookmark}`} onChange={value => onSelectBookmark(+value)}>
              <Stack gap="xs">
                <Radio value="-1" label="Default workspace" />
                {state.bookmarks.map((bookmark, i) => <Radio key={i} value={`${i}`} label={bookmark.name.replace(/\//g, " / ")} />)}
              </Stack>
            </Radio.Group>
          </ScrollArea.Autosize>)}

          {renderSection("Presets", "Reuse a saved connection setup.", <ScrollArea.Autosize mah={180}>
            {Object.keys(state.presets).length === 0 && <Text size="sm" c="dimmed">No saved presets yet.</Text>}
            <Radio.Group value={`[${state.type}]:${state.path}`} onChange={onSelectPreset}>
              <Stack gap="xs">
                {Object.keys(state.presets).map(key => <Radio key={key} value={key} label={key} />)}
              </Stack>
            </Radio.Group>
          </ScrollArea.Autosize>)}
        </SimpleGrid>

        <Group pt={20} pb={4}>
          <Text size="xs" c="dimmed">Ready when you are.</Text>
          <Box style={{ flexGrow: 1 }} />
          <Button type="submit">Start Envim</Button>
        </Group>
      </form>
    </ScrollArea>
  );
}
