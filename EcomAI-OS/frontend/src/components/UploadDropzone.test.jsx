// The upload zone, which is where two of the reported defects lived.
//
// 1. "Upload Data" in the page header only reset the flow to its first step, so
//    clicking it appeared to do nothing: no file dialog opened. The zone now
//    exposes its own input through a ref, and the page opens that, so there is
//    still exactly one <input type="file"> and one handler for both entry
//    points. These tests pin the ref and the single input.
// 2. "Download template" sits inside the clickable zone, so asking for the
//    template also opened the file dialog; cancelling that dialog then read as
//    the download having failed.

import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import UploadDropzone from './UploadDropzone';

function renderZone(props = {}) {
  const ref = createRef();
  const onFile = vi.fn();
  const onDownloadTemplate = vi.fn();
  render(
    <UploadDropzone
      ref={ref}
      onFile={onFile}
      onDownloadTemplate={onDownloadTemplate}
      {...props}
    />,
  );
  const input = document.querySelector('input[type="file"]');
  return { ref, input, onFile, onDownloadTemplate };
}

/** jsdom does not open a file dialog, so the click on the input is the signal. */
function watchInputClicks(input) {
  const clicks = vi.fn();
  input.addEventListener('click', clicks);
  return clicks;
}

function csvFile(name = 'sales.csv', text = 'date,product_id,units_sold\n') {
  const file = new File([text], name, { type: 'text/csv' });
  return file;
}

/** The nested "Download template" control, not the zone around it.
 *
 * The zone itself carries `role="button"` and its accessible name is built from
 * all the text inside it, so a name-based query for the template matches both.
 */
function templateButton() {
  return document.querySelector('button[type="button"]');
}

describe('opening the file picker', () => {
  it('has exactly one file input, so a page button and the zone cannot diverge', () => {
    renderZone();

    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('opens the browser dialog when the zone is clicked', () => {
    const { input } = renderZone();
    const clicks = watchInputClicks(input);

    fireEvent.click(screen.getByRole('button', { name: /drag and drop/i }));

    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('opens it on Enter and Space too', () => {
    const { input } = renderZone();
    const clicks = watchInputClicks(input);
    const zone = screen.getByRole('button', { name: /drag and drop/i });

    fireEvent.keyDown(zone, { key: 'Enter' });
    fireEvent.keyDown(zone, { key: ' ' });

    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it('opens it from outside through the ref, which is what the page button uses', () => {
    const { ref, input } = renderZone();
    const clicks = watchInputClicks(input);

    ref.current.openFilePicker();

    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('refuses to open while disabled, so a page cannot import during a request', () => {
    const { ref, input } = renderZone({ disabled: true });
    const clicks = watchInputClicks(input);

    ref.current.openFilePicker();
    fireEvent.click(screen.getByRole('button', { name: /drag and drop/i }));

    expect(clicks).not.toHaveBeenCalled();
  });

  it('hands a dropped file to the same handler as a chosen one', async () => {
    const { input, onFile } = renderZone();
    const dropZone = screen.getByRole('button', { name: /drag and drop/i });
    const clicks = watchInputClicks(input);

    fireEvent.drop(dropZone, { dataTransfer: { files: [csvFile()] } });
    await vi.waitFor(() => expect(onFile).toHaveBeenCalledTimes(1));

    const [text, name, error] = onFile.mock.calls[0];
    expect(text).toContain('date,product_id,units_sold');
    expect(name).toBe('sales.csv');
    expect(error).toBeNull();
    // A drop is not a click: it must not also open the dialog.
    expect(clicks).not.toHaveBeenCalled();
  });

  it('reports a non-CSV file as an error instead of reading it', () => {
    const { onFile } = renderZone();

    fireEvent.drop(screen.getByRole('button', { name: /drag and drop/i }), {
      dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile.mock.calls[0][2]).toBeInstanceOf(Error);
  });
});

describe('downloading the template from inside the zone', () => {
  it('downloads without also opening the file dialog', () => {
    const { input, onDownloadTemplate } = renderZone();
    const clicks = watchInputClicks(input);

    fireEvent.click(templateButton());

    expect(onDownloadTemplate).toHaveBeenCalledTimes(1);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('does not open the dialog when it is activated from the keyboard', () => {
    const { input, onDownloadTemplate } = renderZone();
    const clicks = watchInputClicks(input);
    const button = templateButton();

    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);

    expect(onDownloadTemplate).toHaveBeenCalledTimes(1);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('still falls back to the onDownloadSample alias', () => {
    const onDownloadSample = vi.fn();
    const { input } = renderZone({ onDownloadTemplate: undefined, onDownloadSample });
    const clicks = watchInputClicks(input);

    fireEvent.click(templateButton());

    expect(onDownloadSample).toHaveBeenCalledTimes(1);
    expect(clicks).not.toHaveBeenCalled();
  });
});
