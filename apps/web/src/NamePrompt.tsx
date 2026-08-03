import { useEffect, useRef, useState } from 'react';
import { StylePicker } from './StylePicker.js';

/**
 * Kleiner Dialog zum Benennen einer frisch gezeichneten Markierung.
 * Enter speichert, Escape verwirft.
 */
export function NamePrompt(props: {
  title: string;
  defaultName: string;
  confirmLabel?: string;
  /** Farbe und (bei Punkten) Symbol gleich mitwählen. */
  style?: { color: string; icon?: string };
  onSave: (name: string, style?: { color: string; icon?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.defaultName);
  const [color, setColor] = useState(props.style?.color ?? 'teal');
  const [icon, setIcon] = useState(props.style?.icon ?? 'dot');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props]);

  const save = () =>
    props.onSave(
      name.trim() || props.defaultName,
      props.style ? { color, ...(props.style.icon !== undefined ? { icon } : {}) } : undefined,
    );

  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <form
        className="sheet namebox"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2>{props.title}</h2>
        <input
          ref={inputRef}
          className="nameinput"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={props.defaultName}
          aria-label="Name"
          maxLength={60}
        />
        {props.style && (
          <StylePicker
            color={color}
            onColor={setColor}
            {...(props.style.icon !== undefined ? { icon, onIcon: setIcon } : {})}
          />
        )}
        <div className="namebtns">
          <button type="button" className="rbtn ghost" onClick={props.onCancel}>
            Verwerfen
          </button>
          <button type="submit" className="rbtn">
            {props.confirmLabel ?? 'Speichern'}
          </button>
        </div>
      </form>
    </div>
  );
}
