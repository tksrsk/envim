import React from "react";
import { Button, Checkbox, CloseButton, Group, Modal, NumberInput, PasswordInput, Radio, Stack, Text, TextInput } from "@mantine/core";

import { FocusProvider } from "renderer/context/focus";
import { useWorkspace } from "renderer/context/workspace";
import { uiIcons } from "renderer/utils/icons";

import { trackMenu } from "renderer/components/menu";

import { IFormRequest, IFormValues, ISchema } from "common/schema";

type Entries = [string, unknown][];

interface FormProps extends Omit<IFormRequest, "reply"> {
  opened: boolean;
  onReply: (action?: string, values?: unknown) => void;
}

export function FormHostComponent() {
  const { active, emit } = useWorkspace();
  const [queue, setQueue] = React.useState<{ id: number; request: IFormRequest }[]>([]);
  const current = queue[0];

  React.useEffect(() => {
    let id = 0;
    const open = (request: IFormRequest) => setQueue(queue => [...queue, { id: ++id, request }]);

    emit.on("form:open", open);
    return () => emit.off("form:open", open);
  }, [emit]);

  function reply(action?: string, values?: unknown) {
    const { event, via, args = [] } = current.request.reply;

    emit[via](event, ...args, action, values);
    setQueue(queue => queue.slice(1));
  }

  return current ? <FormModalComponent key={current.id} {...current.request} opened={active} onReply={reply} /> : null;
}

function getOptions(schema: ISchema) {
  const items = schema.type === "array" ? schema.items : schema;
  const options = items?.oneOf || items?.anyOf || items?.enum?.map(value => ({ const: value, title: value }));

  return options?.map(option => ({ value: option.const, title: option.title }));
}

function isEntries(schema: ISchema) {
  return schema.type === "object" && !schema.properties;
}

function toData(schema: ISchema, value: unknown): unknown {
  value = value ?? schema.const ?? schema.default;

  if (schema.properties) {
    const object = (value ?? {}) as IFormValues;
    return Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, toData(property, object[key])]));
  }
  if (isEntries(schema)) {
    const item = typeof schema.additionalProperties === "object" ? schema.additionalProperties : { type: "string" };
    return Object.entries((value ?? {}) as IFormValues).map(([key, entry]) => [key, toData(item, entry)]);
  }
  if (schema.type === "array" && !getOptions(schema)) {
    return ((value ?? []) as unknown[]).map(item => toData(schema.items ?? { type: "string" }, item));
  }

  return value ?? (schema.type === "boolean" ? false : schema.type === "array" ? [] : "");
}

function fromData(schema: ISchema, data: unknown, original: unknown, required = true): unknown {
  if (schema.properties) {
    const object = data as IFormValues;
    const values = Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => (
      [key, fromData(property, object[key], (original as IFormValues | undefined)?.[key], !!schema.required?.includes(key))]
    )));

    return Object.fromEntries(Object.entries({ ...(original as IFormValues | undefined), ...values }).filter(([, value]) => value !== undefined));
  }
  if (isEntries(schema)) {
    const item = typeof schema.additionalProperties === "object" ? schema.additionalProperties : { type: "string" };
    return Object.fromEntries((data as Entries).map(([key, value]) => [key, fromData(item, value, undefined)]));
  }
  if (schema.type === "array" && !getOptions(schema)) {
    return (data as unknown[]).map(item => fromData(schema.items ?? { type: "string" }, item, undefined));
  }
  if (schema.type === "number" || schema.type === "integer") {
    return data === "" ? undefined : Number(data);
  }

  return data === "" && !required ? undefined : data;
}

function FormModalComponent({ opened, title, message, url, schema, values, actions, onReply }: FormProps) {
  const id = React.useId();
  const [data, setData] = React.useState(() => schema && toData(schema, values));

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const action = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;

    e.preventDefault();
    action && onReply(action, schema && fromData(schema, data, values));
  }

  function renderList<T>(items: T[], onChange: (items: T[]) => void, create: () => T, render: (item: T, onChange: (item: T) => void, index: number) => React.ReactNode) {
    return (
      <Stack gap={4}>
        {items.map((item, i) => (
          <Group key={i} gap={4} wrap="nowrap" align="flex-start">
            <Group gap={4} wrap="nowrap" style={{ flex: 1 }} grow>{render(item, next => onChange(items.with(i, next)), i)}</Group>
            <CloseButton title="Remove" onClick={() => onChange(items.toSpliced(i, 1))} />
          </Group>
        ))}
        <Button variant="subtle" color="gray" size="compact-xs" style={{ alignSelf: "flex-start" }} leftSection={<i>{uiIcons.add}</i>} onClick={() => onChange([...items, create()])}>Add</Button>
      </Stack>
    );
  }

  function renderField(schema: ISchema, value: unknown, onChange: (value: unknown) => void, path: (string | number)[], label?: string, required = false, compact = false): React.ReactNode {
    const options = getOptions(schema);
    const common = { label, description: schema.description, required, size: "xs" as const };

    if (schema.const !== undefined) return null;

    if (schema.properties) {
      const object = value as IFormValues;
      const fields = Object.entries(schema.properties).map(([key, property]) => (
        <React.Fragment key={key}>
          {renderField(property, object[key], next => onChange({ ...object, [key]: next }), [...path, key], compact ? undefined : property.title || key, !!schema.required?.includes(key), compact)}
        </React.Fragment>
      ));

      return compact ? fields : (
        <Stack gap={8}>
          {schema.title && <Text size="xs" fw={500}>{schema.title}</Text>}
          {fields}
        </Stack>
      );
    }

    if (isEntries(schema)) {
      const item = typeof schema.additionalProperties === "object" ? schema.additionalProperties : { type: "string" };

      return (
        <Stack gap={4}>
          {label && <Text size="xs" fw={500}>{label}</Text>}
          {renderList<Entries[number]>(value as Entries, onChange, () => ["", toData(item, undefined)], ([key, entry], change, index) => <>
            <TextInput size="xs" placeholder="Key" value={key} required onChange={e => change([e.currentTarget.value, entry])} />
            {renderField(item, entry, next => change([key, next]), [...path, index], undefined, false, true)}
          </>)}
        </Stack>
      );
    }

    if (options) {
      const selected = ([] as unknown[]).concat(value);
      const Choice = schema.type === "array" ? Checkbox : Radio;
      const name = `${id}-${JSON.stringify(path)}`;
      const select = (option: string, checked: boolean) => onChange(schema.type === "array"
        ? checked ? [...selected, option] : selected.filter(item => item !== option)
        : option);

      return (
        <Stack gap={4}>
          <Text size="xs" fw={500}>{label}{required && " *"}</Text>
          {schema.description && <Text size="xs" c="dimmed">{schema.description}</Text>}
          {schema.type !== "array" && !required && <Radio name={name} value="" size="xs" label="Not select" checked={!value} onChange={() => onChange("")} />}
          {options.map(option => (
            <Choice key={option.value} name={name} value={option.value} size="xs" label={option.title} checked={selected.includes(option.value)}
              required={Choice === Radio && required} onChange={e => select(option.value, e.currentTarget.checked)} />
          ))}
        </Stack>
      );
    }

    switch (schema.type) {
      case "array":
        return (
          <Stack gap={4}>
            {label && <Text size="xs" fw={500}>{label}</Text>}
            {schema.description && <Text size="xs" c="dimmed">{schema.description}</Text>}
            {renderList(value as unknown[], onChange, () => toData(schema.items ?? { type: "string" }, undefined), (item, change, index) => renderField(schema.items ?? { type: "string" }, item, change, [...path, index], undefined, true, true))}
          </Stack>
        );
      case "boolean":
        return <Checkbox size="xs" label={label} description={schema.description} checked={!!value} onChange={e => onChange(e.currentTarget.checked)} />;
      case "number":
      case "integer":
        return <NumberInput {...common} allowDecimal={schema.type !== "integer"} min={schema.minimum as number} max={schema.maximum as number} value={value as number | string} onChange={onChange} />;
    }

    if (schema.format === "password") {
      return <PasswordInput {...common} value={value as string} onChange={e => onChange(e.currentTarget.value)} />;
    }

    return <TextInput {...common} placeholder={compact ? schema.title ?? undefined : schema.format as string} minLength={schema.minLength as number} maxLength={schema.maxLength as number}
      pattern={schema.pattern as string} value={value as string} onChange={e => onChange(e.currentTarget.value)} />;
  }

  return (
    <FocusProvider>
      <Modal opened={opened} onClose={() => onReply()} title={title} centered>
        <Stack ref={trackMenu} gap={8}>
          {message && <Text size="xs" style={{ whiteSpace: "pre-wrap" }}>{message}</Text>}
          {url && <Text size="xs" c="orange" title={url}>{new URL(url).host}</Text>}
          <form onSubmit={onSubmit}>
            <Stack gap={8}>
              {schema && renderField(schema, data, setData, [])}
              <Group grow gap={4}>
                {actions.map(action => (
                  <Button key={action.name} type={action.submit ? "submit" : "button"} value={action.action} variant="light" color={action.color} size="xs" title={action.name}
                    leftSection={<i>{action.font}</i>} onClick={action.submit ? undefined : () => onReply(action.action)}>
                    {action.name}
                  </Button>
                ))}
              </Group>
            </Stack>
          </form>
        </Stack>
      </Modal>
    </FocusProvider>
  );
}
