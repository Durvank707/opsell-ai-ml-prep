import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { UploadCloud, FileSpreadsheet, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Drag-and-drop + browse file upload area for CSV data.
 * Files are read as text via FileReader and handed to onFile(text, filename).
 * `onDownloadTemplate` (or its alias `onDownloadSample`) triggers the
 * "Download template" link; `hint` is shown next to the format note and should
 * name the columns the flow accepts.
 *
 * The file input is opened by clicking anywhere in the zone, by Enter/Space, or
 * from outside through the ref (`openFilePicker()`), so a page button such as
 * "Upload Data" can start exactly the flow the zone does — the browser's own
 * file dialog, feeding the same `onFile` handler. There is one input and one
 * handler either way, so the two entry points cannot diverge.
 */
const UploadDropzone = forwardRef(function UploadDropzone(
  {
    onFile,
    onDownloadTemplate,
    onDownloadSample,
    hint = 'Columns: date, product_id, units_sold',
    compact = false,
    disabled = false,
  },
  ref,
) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState(null);

  // Exposed so a button elsewhere on the page can open this zone's picker
  // instead of rendering a second, hidden <input type="file"> of its own.
  useImperativeHandle(ref, () => ({
    openFilePicker() {
      if (!disabled) inputRef.current?.click();
    },
    reset() {
      setFileName(null);
      if (inputRef.current) inputRef.current.value = '';
    },
  }));

  const handleFiles = (files) => {
    const file = files && files[0];
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
      onFile(null, file.name, new Error('Only .csv files are supported.'));
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => onFile(String(reader.result || ''), file.name, null);
    reader.onerror = () => onFile(null, file.name, new Error('Unable to read this file.'));
    reader.readAsText(file);
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={() => {
          // A disabled zone must not open a dialog: while an import is running,
          // a stray click would queue a second file against a flow that cannot
          // accept it.
          if (disabled) return;
          inputRef.current?.click();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed bg-slate-50/60 transition-colors',
          dragging ? 'border-brand-400 bg-brand-50' : 'border-slate-300 hover:border-brand-400 hover:bg-brand-50/40',
          compact ? 'px-6 py-8' : 'px-6 py-14',
          disabled && 'cursor-not-allowed opacity-60',
          !disabled && 'cursor-pointer',
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-soft ring-1 ring-slate-200">
          <UploadCloud className={cn('h-6 w-6', dragging ? 'text-brand-600' : 'text-slate-400')} />
        </div>
        <p className="mt-3 text-sm font-semibold text-slate-700">
          {fileName ? `Selected: ${fileName}` : 'Drag and drop your CSV file here'}
        </p>
        <p className="mt-0.5 text-xs text-slate-400">or</p>
        <span className="mt-2 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
          Browse Files
        </span>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <FileSpreadsheet className="h-3.5 w-3.5" /> Supported format: CSV
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" /> {hint}
          </span>
          {/* The zone is itself a button, so this nested control stops both
              click and key events from bubbling: without that, asking for the
              template also opened the file dialog, and the dialog's cancel
              read to the tenant as the download having failed. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              (onDownloadTemplate || onDownloadSample)?.();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="font-semibold text-brand-600 hover:text-brand-700"
          >
            Download template
          </button>
        </div>
      </div>
    </div>
  );
});

export default UploadDropzone;