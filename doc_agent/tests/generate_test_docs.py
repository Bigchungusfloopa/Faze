"""
Creates fixture files under sample_docs/ so the test suite can exercise
every pipeline without needing real-world uploads:

  policy.pdf         - clean text PDF (TEXT_PDF pipeline)
  salary_table.pdf   - table-dominant PDF (TABLE pipeline)
  scanned_notice.pdf - image-only PDF, i.e. no extractable text layer,
                       simulating a noisy scan (SCANNED_PDF pipeline)
  logo.png           - standalone image (IMAGE pipeline)

Also registers deterministic mock-OCR ground truth for the scanned PDF
and image, via agent.gemini_client.register_mock_ocr, so tests can assert
exact expected content came through the "OCR"/vision step.
"""

import io
import os
from typing import Any

import fitz  # PyMuPDF
from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import Table, TableStyle, SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas

SAMPLE_DIR = os.path.join(os.path.dirname(__file__), "..", "sample_docs")
os.makedirs(SAMPLE_DIR, exist_ok=True)


def make_policy_pdf():
    path = os.path.join(SAMPLE_DIR, "policy.pdf")
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 750, "Remote Work Policy")
    c.setFont("Helvetica", 11)
    c.drawString(72, 720, "Employees are permitted to work remotely up to 3 days per week.")
    c.drawString(72, 700, "Remote work requests must be approved by a direct manager.")
    c.drawString(72, 680, "All remote employees must be reachable during core hours, 10am-4pm.")
    c.showPage()
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 750, "Equipment Policy")
    c.setFont("Helvetica", 11)
    c.drawString(72, 720, "The company provides a laptop and monitor for all remote employees.")
    c.drawString(72, 700, "Employees are responsible for maintaining a secure home network.")
    c.save()
    return path


def make_salary_table_pdf():
    """Uses a real reportlab Table flowable (with ruling lines) rather than
    hand-positioned text, so pdfplumber's grid-based table detector
    (page.find_tables()) actually fires -- this is what makes it a genuine
    TABLE-pipeline test case rather than accidentally plain text."""
    path = os.path.join(SAMPLE_DIR, "salary_table.pdf")
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(path, pagesize=letter)
    data = [
        ["Department", "Headcount", "Annual Budget (USD)"],
        ["Engineering", "42", "6,200,000"],
        ["Sales", "18", "2,100,000"],
        ["Marketing", "9", "1,050,000"],
    ]
    table = Table(data, colWidths=[160, 100, 160])
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 1, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
    ]))
    elements = [
        Paragraph("Department Budget FY2026", styles["Heading2"]),
        Spacer(1, 12),
        table,
    ]
    doc.build(elements)
    return path


def make_scanned_pdf_and_register_ocr():
    """Builds a PDF page containing ONLY a rasterized image (no text layer)
    to genuinely trigger the SCANNED_PDF routing path, then registers what
    the mock vision call should 'read' off that rendered page."""
    path = os.path.join(SAMPLE_DIR, "scanned_notice.pdf")

    # Build an image that looks like a noisy scanned notice
    img = Image.new("RGB", (1600, 2000), color=(250, 248, 240))
    draw = ImageDraw.Draw(img)
    draw.text((100, 100), "OFFICE NOTICE", fill=(20, 20, 20))
    draw.text((100, 160), "Parking garage B closed for maintenance", fill=(20, 20, 20))
    draw.text((100, 200), "from Oct 1 to Oct 15, 2026.", fill=(20, 20, 20))
    # add visual noise to simulate a poor scan
    import random
    random.seed(7)
    for _ in range(4000):
        x, y = random.randint(0, 1599), random.randint(0, 1999)
        draw.point((x, y), fill=(random.randint(150, 220),) * 3)

    doc = fitz.open()
    page = doc.new_page(width=1600, height=2000)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(path)
    doc.close()

    # Now render the page exactly the way extractors.extract_scanned_pdf
    # will (same dpi) so the hash matches, and register expected OCR text.
    rendered = fitz.open(path)
    pix = rendered[0].get_pixmap(dpi=200)
    rendered_bytes = pix.tobytes("png")
    rendered.close()

    from agent.gemini_client import register_mock_ocr
    register_mock_ocr(
        rendered_bytes,
        "OFFICE NOTICE. Parking garage B closed for maintenance from Oct 1 to Oct 15, 2026.",
    )
    return path


def make_logo_image_and_register_caption():
    path = os.path.join(SAMPLE_DIR, "logo.png")
    img = Image.new("RGB", (400, 200), color=(30, 60, 114))
    draw = ImageDraw.Draw(img)
    draw.text((40, 90), "NORTHWIND LOGISTICS", fill=(255, 255, 255))
    img.save(path)

    with open(path, "rb") as f:
        img_bytes = f.read()

    from agent.gemini_client import register_mock_ocr
    register_mock_ocr(
        img_bytes,
        "A dark blue rectangular logo with the white text 'NORTHWIND LOGISTICS'.",
    )
    return path


def make_conflicting_policy_pdf():
    """A second, contradictory 'remote work' doc so tests can verify the
    agent surfaces conflicts instead of silently picking one source."""
    path = os.path.join(SAMPLE_DIR, "updated_policy.pdf")
    c = canvas.Canvas(path, pagesize=letter)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(72, 750, "Remote Work Policy (2026 Revision)")
    c.setFont("Helvetica", 11)
    c.drawString(72, 720, "Employees are permitted to work remotely up to 5 days per week.")
    c.drawString(72, 700, "Remote work requests must be approved by HR, not the direct manager.")
    c.save()
    return path


def make_sample_xlsx():
    import openpyxl
    path = os.path.join(SAMPLE_DIR, "students_records.xlsx")
    wb = openpyxl.Workbook()
    ws: Any = wb.active
    if ws is None:
        ws = wb.create_sheet(title="Students")
    else:
        ws.title = "Students"
    ws.append(["Student_ID", "Name", "Major", "GPA", "Credits_Completed", "Graduation_Year"])
    ws.append(["STU-101", "Alice Vance", "Computer Science", 3.85, 90, 2025])
    ws.append(["STU-102", "Bob Smith", "Mechanical Engineering", 3.20, 60, 2026])
    ws.append(["STU-103", "Carol Danvers", "Data Science", 3.95, 110, 2024])
    ws.append(["STU-104", "David Miller", "Computer Science", 2.90, 45, 2027])
    ws.append(["STU-105", "Emma Watson", "Physics", 3.70, 75, 2025])
    wb.save(path)
    return path


def generate_all():
    return {
        "policy": make_policy_pdf(),
        "table": make_salary_table_pdf(),
        "scanned": make_scanned_pdf_and_register_ocr(),
        "image": make_logo_image_and_register_caption(),
        "conflicting_policy": make_conflicting_policy_pdf(),
        "students_xlsx": make_sample_xlsx(),
    }


if __name__ == "__main__":
    paths = generate_all()
    for k, v in paths.items():
        print(f"{k}: {v}")
