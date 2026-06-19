import html2canvas from "html2canvas-pro";
import { jsPDF } from "jspdf";

const BG = "#0a1929";

/**
 * Capture the live element directly (no cloning).
 * This preserves all Tailwind computed styles and avoids blank/invisible output.
 */
async function capture(el: HTMLElement): Promise<HTMLCanvasElement> {
  // Scroll to top so the capture starts from the beginning
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 300));

  return html2canvas(el, {
    backgroundColor: BG,
    scale: 2,
    useCORS: true,
    logging: false,
    width: el.scrollWidth,
    height: el.scrollHeight,
    windowWidth: el.scrollWidth,
    windowHeight: el.scrollHeight,
    x: 0,
    y: 0,
    scrollX: 0,
    scrollY: 0,
  });
}

export async function exportToPNG(el: HTMLElement, fileName: string): Promise<void> {
  const canvas = await capture(el);
  const url = canvas.toDataURL("image/png", 1.0);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileName}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function exportToPDF(el: HTMLElement, fileName: string): Promise<void> {
  const canvas = await capture(el);
  const imgData = canvas.toDataURL("image/png", 1.0);

  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const m = 4;
  const iw = pw - m * 2;
  const ih = (canvas.height * iw) / canvas.width;

  let left = ih;
  let y = m;

  const bg = () => {
    pdf.setFillColor(10, 25, 41);
    pdf.rect(0, 0, pw, ph, "F");
  };

  bg();
  pdf.addImage(imgData, "PNG", m, y, iw, ih, undefined, "FAST");
  left -= ph - m * 2;

  while (left > 0) {
    y -= ph - m * 2;
    pdf.addPage();
    bg();
    pdf.addImage(imgData, "PNG", m, y, iw, ih, undefined, "FAST");
    left -= ph - m * 2;
  }

  pdf.save(`${fileName}.pdf`);
}
