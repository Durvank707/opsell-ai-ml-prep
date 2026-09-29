// Import Products (CSV) modal.
//
// Mirrors the Sales upload flow (choose file -> validate -> review -> commit)
// against the canonical product contract, reusing the shared ImportGuide,
// UploadDropzone and import-flow pieces. Validation reports and imports are
// handled by the product service, which never silently accepts bad rows.

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, UploadCloud } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import UploadDropzone from './UploadDropzone';
import ImportGuide from './ImportGuide';
import { ErrorsList, ImportStats, ImportStepsIndicator, UploadPhase } from './importFlow';
import {
  downloadProductTemplateCsv,
  uploadProductCsv,
  validateProductCsv,
} from '../services/productsService';
import { cn } from '../lib/utils';

export default function ImportProductsModal({ open, onClose, user, onImported }) {
  const [phase, setPhase] = useState('idle');
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState('');
  const [validation, setValidation] = useState(null);
  const [showErrors, setShowErrors] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    if (!open) resetUpload();
    return () => clearTimeout(timerRef.current);
  }, [open]);

  const handleFile = (text, name, err) => {
    if (err) {
      setUploadError(err.message);
      setPhase('error');
      return;
    }
    setFileText(text);
    setFileName(name);
    setPhase('validating');
    timerRef.current = setTimeout(runValidation, 400, text);
  };

  const runValidation = async (text) => {
    try {
      const result = await validateProductCsv(text, user);
      setValidation(result);
      setPhase(result.ok ? 'ready' : 'error');
      if (!result.ok) {
        setUploadError('No rows in the file are valid. Fix them and re-upload.');
      }
    } catch (e) {
      setUploadError(e.message || 'Unable to validate the file. Please try again.');
      setPhase('error');
    }
  };

  const handleImport = async () => {
    setPhase('importing');
    try {
      const result = await uploadProductCsv(user, fileText);
      setValidation(result);
      setPhase('done');
      onImported?.(result);
    } catch (e) {
      setUploadError(e.message || 'Import failed. Please try again.');
      setPhase('error');
    }
  };

  const resetUpload = () => {
    clearTimeout(timerRef.current);
    setPhase('idle');
    setFileName('');
    setFileText('');
    setValidation(null);
    setShowErrors(false);
    setUploadError('');
  };

  const ready = phase !== 'done' && phase !== 'error' && validation && phase === 'ready';
  const stepIndex = { idle: 0, validating: 2, ready: 2, importing: 3, done: 3, error: 2 }[phase] ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import Products (CSV)"
      description="Add many products to your catalog from a CSV file."
      width="max-w-2xl"
      footer={
        ready ? (
          <Button icon={UploadCloud} onClick={handleImport}>
            Import {validation.validRows} New {validation.validRows === 1 ? 'Product' : 'Products'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="mb-3 flex justify-end">
        <ImportStepsIndicator stepIndex={stepIndex} phase={phase} />
      </div>
      {phase === 'idle' ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <ImportGuide recordType="product" className="w-full" />
          <UploadDropzone
            compact
            onFile={handleFile}
            onDownloadTemplate={() => downloadProductTemplateCsv(user)}
            hint="Template: 14 columns, 3 required"
            disabled={false}
          />
          <p className="max-w-md text-xs leading-relaxed text-slate-400">
            EcomAI-OS validates every row against your catalog before adding anything — duplicates,
            missing IDs and bad stock counts are shown so you can fix and re-upload.
          </p>
        </div>
      ) : phase === 'validating' ? (
        <UploadPhase icon={AlertCircle} title={`Validating ${fileName}…`} subtitle="Checking product IDs, names and stock column by column." loading />
      ) : phase === 'importing' ? (
        <UploadPhase icon={UploadCloud} title="Importing your products…" subtitle="Adding valid rows to your catalog. This usually takes a few seconds." loading />
      ) : phase === 'done' && validation ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="text-sm font-bold text-slate-800">Import completed successfully</p>
              <p className="mt-0.5 text-xs text-slate-600">{validation.message}</p>
            </div>
          </div>
          <ImportStats validation={validation} />
          {validation.skippedRows > 0 && (
            <ErrorsList validation={validation} showErrors={showErrors} setShowErrors={setShowErrors} />
          )}
        </div>
      ) : phase === 'error' ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
            <div>
              <p className="text-sm font-bold text-slate-800">Import failed</p>
              <p className="mt-0.5 text-xs text-slate-600">{uploadError}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={resetUpload}>
              Choose a File
            </Button>
          </div>
        </div>
      ) : validation ? (
        <div className="space-y-4">
          <div
            className={cn(
              'flex items-start gap-3 rounded-2xl border p-4',
              validation.skippedRows > 0 ? 'border-amber-200 bg-amber-50/60' : 'border-emerald-200 bg-emerald-50/60',
            )}
          >
            {validation.skippedRows > 0 ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            )}
            <div>
              <p className="text-sm font-bold text-slate-800">
                {validation.skippedRows > 0 ? 'Validation completed with warnings' : 'Validation passed'}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">{validation.message}</p>
            </div>
          </div>
          <ImportStats validation={validation} variant="products" />
          {validation.skippedRows > 0 && (
            <ErrorsList validation={validation} showErrors={showErrors} setShowErrors={setShowErrors} />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={resetUpload}>
              Re-upload
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}