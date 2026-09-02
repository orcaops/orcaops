import { useRenderer } from '@opentui/react';
import { useState } from 'react';

import { editTextViaEditor, TextComposer } from '@orcaops/diff-render';

import { useCockpitTheme } from '../ThemeProvider';
import { Notice } from '../kit';
import { truncate } from '../layout';
import { ModalFrame } from './ModalFrame';

export interface InputModalProps {
  title: string;
  context?: string;
  guidance?: readonly string[];
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  required?: boolean;
  emptyMessage?: string;
  width: number;
  height: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A retained-reader text composer with one keyboard and pointer action model. */
export function InputModal({
  title,
  context,
  guidance = [],
  placeholder,
  initial,
  submitLabel = 'Save',
  required = false,
  emptyMessage = 'Enter text before saving.',
  width,
  height,
  onSubmit,
  onCancel,
}: InputModalProps) {
  const { DIM, FG, FOCUS_BG } = useCockpitTheme();
  const renderer = useRenderer();
  const initialText = initial ?? '';
  const [seed, setSeed] = useState({ gen: 0, text: initialText });
  const [draft, setDraft] = useState(initialText);
  const [notice, setNotice] = useState<string | null>(null);

  const desiredWidth = Math.min(80, Math.max(38, width - 8));
  const desiredHeight = Math.min(18, Math.max(11, height - 4));
  const metaLines = [context, ...guidance.slice(0, 2)].filter(
    (line): line is string => line !== undefined
  );

  const submit = (text: string): void => {
    const normalized = text.trim();
    if (required && normalized.length === 0) {
      setNotice(emptyMessage);
      return;
    }
    setNotice(null);
    onSubmit(text);
  };

  const requestEditor = (currentText: string): void => {
    if (renderer === null) {
      setNotice('Editor unavailable because the terminal renderer is not active.');
      return;
    }
    const result = editTextViaEditor({ initialText: currentText, renderer });
    if (result.text !== null) {
      setSeed((current) => ({ gen: current.gen + 1, text: result.text ?? '' }));
      setDraft(result.text ?? '');
      setNotice(null);
    } else {
      setNotice(result.error);
    }
  };

  return (
    <ModalFrame
      id="review-input-modal"
      backdropId="review-input-backdrop"
      title={title}
      width={width}
      height={height}
      desiredWidth={desiredWidth}
      desiredHeight={desiredHeight}
      onClose={onCancel}
      opaqueBackdrop
      actions={[
        {
          id: 'save',
          keyLabel: '^S',
          label: submitLabel,
          shortLabel: 'Save',
          priority: 0,
          required: true,
          onSelect: () => submit(draft),
        },
        {
          id: 'cancel',
          keyLabel: 'Esc',
          label: 'Cancel',
          shortLabel: 'Cancel',
          priority: 0,
          required: true,
          onSelect: onCancel,
        },
      ]}
    >
      {(geometry) => {
        const composerWidth = Math.max(1, geometry.innerWidth - 2);
        const footerRows = geometry.bodyRows >= 2 ? 1 : 0;
        const footerGapRows = geometry.bodyRows >= 3 ? 1 : 0;
        const contentRows = geometry.bodyRows - footerRows - footerGapRows;
        const metaRows = Math.min(metaLines.length, Math.max(0, contentRows - 2));
        const metaGapRows = metaRows > 0 ? 1 : 0;
        const composerRows = Math.max(0, Math.min(8, contentRows - metaRows - metaGapRows));
        return (
          <>
            {metaLines.slice(0, metaRows).map((line, index) => (
              <text key={`${index}:${line}`} fg={DIM}>
                {truncate(oneLine(line), composerWidth)}
              </text>
            ))}
            {metaGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {composerRows === 0 ? null : (
              <box
                height={composerRows}
                backgroundColor={FOCUS_BG}
                paddingLeft={1}
                paddingRight={1}
                flexShrink={0}
              >
                <TextComposer
                  key={seed.gen}
                  width={composerWidth}
                  maxRows={composerRows}
                  initialValue={seed.text}
                  placeholder={placeholder}
                  focused={true}
                  textColor={FG}
                  backgroundColor={FOCUS_BG}
                  onSubmit={submit}
                  onCancel={onCancel}
                  onEditorRequest={requestEditor}
                  onChange={(text) => {
                    setDraft(text);
                    if (notice !== null) setNotice(null);
                  }}
                />
              </box>
            )}
            {footerGapRows === 0 ? null : <box height={1} flexShrink={0} />}
            {footerRows === 0 ? null : notice === null ? (
              <text fg={DIM}>
                {truncate('Enter adds a line · ^E opens $EDITOR', composerWidth)}
              </text>
            ) : (
              <Notice
                id="review-input-notice"
                variant="inline"
                rows={1}
                width={composerWidth}
                message={notice}
              />
            )}
          </>
        );
      }}
    </ModalFrame>
  );
}
