import { useEffect, useRef, useState } from 'react';
import { StylePicker } from './StylePicker.js';

/**
 * Kleiner Dialog zum Benennen einer frisch gezeichneten Markierung.
 * Enter speichert, Escape verwirft.
 *
 * Die **Beschreibung** ist freiwillig und steht deshalb unter dem Namen, nicht
 * daneben: Wer im Gehen einen Punkt setzt, tippt einen Namen und drückt Enter;
 * wer mehr festhalten will, findet das Feld direkt darunter. Im Textfeld
 * speichert Enter nicht — dort ist ein Zeilenumbruch das Naheliegende.
 */
export function NamePrompt(props: {
  title: string;
  defaultName: string;
  confirmLabel?: string;
  /** Farbe und (bei Punkten) Symbol gleich mitwählen. */
  style?: { color: string; icon?: string };
  /** Feld für eine freiwillige Beschreibung anbieten (mit Startwert). */
  note?: string;
  onSave: (name: string, style?: { color: string; icon?: string }, note?: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.defaultName);
  const [note, setNote] = useState(props.note ?? '');
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
      note.trim() || undefined,
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
        {props.note !== undefined && (
          <textarea
            className="noteinput"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Beschreibung (freiwillig)"
            aria-label="Beschreibung"
            rows={2}
            maxLength={600}
          />
        )}
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
