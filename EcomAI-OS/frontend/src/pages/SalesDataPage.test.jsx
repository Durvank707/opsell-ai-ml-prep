// The sales page's import flow, end to end through the rendered component.
//
// Three of the reported defects are properties of this page rather than of any
// one service, so they can only be pinned here:
//
//   "Upload Data" opened no file dialog. It reset the flow to its first step and
//   stopped, so clicking it looked broken. It now drives the dropzone's own
//   input — the same input, the same handler — which is asserted by listening
//   for a click on the single file input in the tree.
//
//   After the first import the page stayed on the upload card, so the records
//   that had just been written were below the fold and the success panel took
//   the top of the page. The import now lands on the data view: summary cards
//   and table filled, the upload flow collapsed to a secondary action.
//
//   A sales file naming products this tenant has not added has to say so, in
//   the server's words, rather than "import failed".

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const refresh = vi.fn();
// One stable user object, as the real context holds: a fresh literal on every
// render would re-create the page's load callbacks and re-run every effect,
// which is an artefact of the test rather than a property of the page.
const USER = { id: 'tenant-a', email: 'a@example.com' };

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: USER }),
}));

vi.mock('../context/DataContext', () => ({
  useData: () => ({ refresh }),
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => toast,
}));

const service = vi.hoisted(() => ({
  getSalesData: vi.fn(),
  listSalesRecords: vi.fn(),
  uploadSalesCsv: vi.fn(),
  validateSalesCsv: vi.fn(),
  downloadSalesTemplateCsv: vi.fn(),
  loadSampleSalesData: vi.fn(),
}));

vi.mock('../services/salesService', () => service);

const { default: SalesDataPage } = await import('./SalesDataPage');

const CSV = ['date,product_id,units_sold,price', '2026-09-01,P001,5,799'].join('\n');

const EMPTY_SUMMARY = {
  totalRecords: 0,
  totalUnits: 0,
  totalRevenue: 0,
  pricedRecords: 0,
  lastImport: null,
  dateFrom: null,
  dateTo: null,
  productsCovered: 0,
  channels: [],
  availableChannels: [],
};

const LOADED_SUMMARY = {
  ...EMPTY_SUMMARY,
  totalRecords: 2,
  totalUnits: 7,
  totalRevenue: 3995,
  pricedRecords: 2,
  lastImport: '2026-09-02',
  dateFrom: '2026-09-01',
  dateTo: '2026-09-02',
  productsCovered: 1,
  channels: [{ name: 'Online Store', count: 2, units: 7 }],
  availableChannels: ['Online Store'],
};

const RECORDS = {
  items: [
    {
      id: 'P001-2026-09-01-Online Store',
      date: '2026-09-01',
      productId: 'P001',
      productName: 'Wireless Headphones',
      category: 'Electronics',
      units: 5,
      price: 799,
      revenue: 3995,
      channel: 'Online Store',
    },
    {
      id: 'P001-2026-09-02-Online Store',
      date: '2026-09-02',
      productId: 'P001',
      productName: 'Wireless Headphones',
      category: 'Electronics',
      units: 2,
      price: null,
      revenue: null,
      channel: 'Online Store',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
};

const VALIDATION_OK = {
  ok: true,
  totalRows: 1,
  validRows: 1,
  skippedRows: 0,
  errors: [],
  message: '1 row is ready to import.',
  payload: [{ date: '2026-09-01', productId: 'P001', units: 5, price: 799 }],
};

/** Push a file into the dropzone the way a drag-and-drop does. */
function dropCsv(text = CSV, name = 'sales.csv') {
  const zone = screen.getByRole('button', { name: /drag and drop/i });
  const file = new File([text], name, { type: 'text/csv' });
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });
}

/** The nested "Download template" control.
 *
 * The upload zone is itself a `role="button"` whose accessible name is built
 * from all the text inside it, so a role-and-name query matches the zone and the
 * control at once.
 */
function templateButton() {
  return Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent.trim() === 'Download template',
  );
}

/** "Upload Sales Data" appears twice in the empty state: the page header and the
 * records table's own empty state. The header is first in the document. */
function uploadButtons() {
  return screen.getAllByRole('button', { name: /^upload sales data$/i });
}

function emptyPage() {
  service.getSalesData.mockResolvedValue(EMPTY_SUMMARY);
  service.listSalesRecords.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
  service.validateSalesCsv.mockResolvedValue(VALIDATION_OK);
  return render(<SalesDataPage />);
}

function loadedPage() {
  service.getSalesData.mockResolvedValue(LOADED_SUMMARY);
  service.listSalesRecords.mockResolvedValue(RECORDS);
  return render(<SalesDataPage />);
}

beforeEach(() => {
  service.getSalesData.mockReset();
  service.listSalesRecords.mockReset();
  service.uploadSalesCsv.mockReset();
  service.validateSalesCsv.mockReset();
  service.downloadSalesTemplateCsv.mockReset();
  service.loadSampleSalesData.mockReset();
  service.uploadSalesCsv.mockResolvedValue({ ...VALIDATION_OK, message: '1 record imported.' });
  navigate.mockReset();
  refresh.mockReset();
});

describe('the header Upload Data button', () => {
  it('opens the browser file dialog instead of only resetting the flow', async () => {
    emptyPage();
    await screen.findByText('No sales records found');

    const input = document.querySelector('input[type="file"]');
    const dialogs = vi.fn();
    input.addEventListener('click', dialogs);

    fireEvent.click(uploadButtons()[0]);

    // The zone's own input is the one that is clicked, so a file chosen here is
    // validated and imported by exactly the same handler as a dropped file.
    await waitFor(() => expect(dialogs).toHaveBeenCalledTimes(1));
  });

  it('still downloads the template without opening a dialog', async () => {
    emptyPage();
    await screen.findByText('No sales records found');

    const input = document.querySelector('input[type="file"]');
    const dialogs = vi.fn();
    input.addEventListener('click', dialogs);

    fireEvent.click(templateButton());

    expect(service.downloadSalesTemplateCsv).toHaveBeenCalledTimes(1);
    expect(dialogs).not.toHaveBeenCalled();
  });

  it('is offered from the records table empty state as well, and opens the same input', async () => {
    emptyPage();
    await screen.findByText('No sales records found');

    const input = document.querySelector('input[type="file"]');
    const dialogs = vi.fn();
    input.addEventListener('click', dialogs);

    // The second "Upload Sales Data" is the table's own empty-state action.
    const buttons = uploadButtons();
    expect(buttons.length).toBeGreaterThan(1);
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(dialogs).toHaveBeenCalledTimes(1));
  });
});

describe('the empty state', () => {
  it('shows the column guide, the template link and the upload zone', async () => {
    emptyPage();

    await screen.findByText('No sales records found');
    expect(screen.getByText(/your csv needs these columns/i)).toBeInTheDocument();
    expect(templateButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /drag and drop/i })).toBeInTheDocument();
    // The guide names the catalog requirement, which is the rule behind the
    // refusal message in the next section.
    expect(screen.getByText(/product must already be in your catalog/i)).toBeInTheDocument();
  });
});

describe('the first successful import', () => {
  it('lands on the data view: summary and records, with importing as a secondary action', async () => {
    emptyPage();
    await screen.findByText('No sales records found');

    // The summary starts empty and is repopulated from the server after the
    // import, without a page reload.
    service.getSalesData.mockResolvedValue(LOADED_SUMMARY);
    service.listSalesRecords.mockResolvedValue(RECORDS);

    dropCsv();
    const start = await screen.findByRole('button', { name: /start import/i }, { timeout: 4000 });
    expect(start).toHaveTextContent('Start Import (1 rows)');

    fireEvent.click(start);

    // The records the import just wrote are on screen, not just a success toast.
    await waitFor(() => expect(screen.getAllByText('Wireless Headphones')).toHaveLength(2), {
      timeout: 5000,
    });

    // The summary is repopulated in place too: the card that read zero now reads
    // the number of records the import wrote, with no page reload.
    const summary = screen.getByText('Total Records').closest('.card');
    await waitFor(() => expect(within(summary).getByText('2')).toBeInTheDocument());

    // Importing is still one click away, but as a secondary action on a card
    // that no longer occupies the page.
    expect(screen.getAllByRole('button', { name: /import more sales data/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /view records/i })).toBeInTheDocument();
    // ...and the full upload flow is not on screen until it is asked for.
    expect(screen.queryByRole('button', { name: /drag and drop/i })).toBeNull();
    expect(screen.getByText(/import completed successfully/i)).toBeInTheDocument();

    // The table is the visible result, so the page reloads it in place rather
    // than leaving the tenant on a success panel above a stale table.
    expect(refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('reopens the full upload flow when the secondary action is used', async () => {
    loadedPage();
    await screen.findAllByText('Wireless Headphones');

    // With records loaded, the upload zone is not mounted, so this button is the
    // only way back to it -- and it has to bring the zone itself.
    expect(document.querySelector('input[type="file"]')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /import more sales data/i })[0]);

    expect(await screen.findByRole('button', { name: /drag and drop/i })).toBeInTheDocument();
  });
});

describe('a sales file naming products this tenant has not added', () => {
  it('shows the refusal sentence rather than a bare failure', async () => {
    emptyPage();
    await screen.findByText('No sales records found');

    service.uploadSalesCsv.mockRejectedValue(
      new Error(
        'Sales import contains 3 product IDs that are not in your catalog: P999, P1000, P1001. ' +
          'Add these products to your catalog first, then upload the sales data.',
      ),
    );

    dropCsv();
    const start = await screen.findByRole('button', { name: /start import/i }, { timeout: 4000 });
    fireEvent.click(start);

    await waitFor(() => expect(screen.getByText(/import failed/i)).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(
      screen.getByText(
        /Sales import contains 3 product IDs that are not in your catalog: P999, P1000, P1001\./,
      ),
    ).toBeInTheDocument();
    // Nothing was written, so the page still has no records and does not claim
    // a successful import.
    expect(screen.queryByText(/import completed successfully/i)).toBeNull();
    expect(screen.getByText('No sales records found')).toBeInTheDocument();
  });
});

describe('the revenue column', () => {
  it('shows a priced sale as its value and an unpriced one as a gap, not as zero', async () => {
    loadedPage();

    // The table renders a skeleton until the rows arrive.
    await screen.findAllByText('Wireless Headphones');

    const table = screen.getByRole('table');
    // 5 units at 799.
    expect(within(table).getByText('₹3,995')).toBeInTheDocument();
    // The second record states no price and its product has none either, so its
    // revenue is unknown rather than zero.
    expect(within(table).getByText('—')).toBeInTheDocument();
    expect(within(table).queryByText('₹0')).toBeNull();
  });
});
