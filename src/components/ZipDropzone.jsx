
import { useRef, useState } from "react";
import Icon from "./Icon.jsx";

const MAX_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * A local-only ZIP selection control.
 *
 * WHY: Selecting a file is separate from extracting or analysing it.
 * The engine will process the File object in a later milestone.
 */
export default function ZipDropzone({ onSelect }) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState("");

  function handleFile(file) {
    if (!file) {
      return;
    }

    const hasZipExtension = /\.zip$/i.test(file.name);

    if (!hasZipExtension) {
      setError("Choose a .zip archive. Other file types aren't supported here.");
      return;
    }

    if (file.size === 0) {
      setError("This ZIP archive is empty.");
      return;
    }

    if (file.size > MAX_ZIP_SIZE_BYTES) {
      setError("This archive exceeds the 50 MB upload limit.");
      return;
    }

    setError("");
    onSelect(file);
  }

  function handleInputChange(event) {
    const file = event.target.files?.[0];

    handleFile(file);

    // Clearing the input permits choosing the same file again.
    event.target.value = "";
  }

  function handleDrop(event) {
    event.preventDefault();
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    handleFile(file);
  }

  return (
    <div>
      <div
        className={[
          "zip-dropzone",
          isDragging ? "zip-dropzone--active" : ""
        ].filter(Boolean).join(" ")}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setIsDragging(false);
          }
        }}
        onDrop={handleDrop}
        aria-label="ZIP repository drop area"
      >
        <div className="zip-dropzone-copy">
          <div className="zip-icon">
            <Icon name="zip" size={22} />
          </div>

          <div>
            <strong>Bring your own archive</strong>
            <p>
              Drop a ZIP here or choose a file from your computer.
            </p>
            <p>ZIP files only · Up to 50 MB</p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          className="visually-hidden"
          id="repository-zip"
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          onChange={handleInputChange}
          aria-label="Choose a repository ZIP archive"
        />

        <button
          className="button button--secondary"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          <Icon name="upload" size={16} />
          Choose ZIP
        </button>
      </div>

      {error && (
        <p className="zip-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
