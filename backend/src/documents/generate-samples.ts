import {
  mkdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
} from 'docx';

import {
  PDFDocument,
  StandardFonts,
} from 'pdf-lib';

const repositoryRoot =
  path.resolve(process.cwd(), '..');

const samplesDirectory = path.join(
  repositoryRoot,
  'documents',
  'samples',
);

await mkdir(samplesDirectory, {
  recursive: true,
});

async function createPdf(): Promise<void> {
  const pdf = await PDFDocument.create();

  const font = await pdf.embedFont(
    StandardFonts.Helvetica,
  );

  const boldFont = await pdf.embedFont(
    StandardFonts.HelveticaBold,
  );

  function addPage(
    heading: string,
    lines: string[],
  ) {
    const page = pdf.addPage([
      612,
      792,
    ]);

    let y = 740;

    page.drawText(heading, {
      x: 50,
      y,
      size: 16,
      font: boldFont,
    });

    y -= 35;

    for (const line of lines) {
      page.drawText(line, {
        x: 50,
        y,
        size: 11,
        font,
      });

      y -= 22;
    }
  }

  addPage(
    'North Orbital Digital Access Program Guide',
    [
      'Fictional demonstration document.',
      '',
      'Digital Lab Reservations',
      'Registered participants may reserve a digital lab workstation',
      'for up to 90 minutes per day.',
      'Reservations may be made up to 7 days in advance.',
      '',
      'Equipment',
      'Headsets and webcams are available for use inside the lab.',
      'Lab headsets and webcams may not be taken home.',
    ],
  );

  addPage(
    'Printing and Technical Support',
    [
      'Each registered participant receives 20 black-and-white',
      'printed pages per calendar month.',
      '',
      'Staff can help with basic file saving, printing,',
      'and account sign-in.',
      '',
      'Staff do not repair personal computers.',
      'Staff do not recover passwords for external services.',
    ],
  );

  const bytes = await pdf.save();

  await writeFile(
    path.join(
      samplesDirectory,
      'north-orbital-digital-access-guide.pdf',
    ),
    bytes,
  );
}

async function createDocx(): Promise<void> {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text:
              'North Orbital Volunteer Handbook',
            heading:
              HeadingLevel.TITLE,
          }),

          new Paragraph({
            text:
              'Fictional demonstration document.',
          }),

          new Paragraph({
            text: 'Orientation',
            heading:
              HeadingLevel.HEADING_1,
          }),

          new Paragraph({
            text:
              'New volunteers complete a 60-minute orientation before their first scheduled shift.',
          }),

          new Paragraph({
            text: 'Shift changes',
            heading:
              HeadingLevel.HEADING_1,
          }),

          new Paragraph({
            text:
              'Volunteers should cancel a scheduled shift at least 12 hours in advance when possible.',
          }),

          new Paragraph({
            text: 'Community conduct',
            heading:
              HeadingLevel.HEADING_1,
          }),

          new Paragraph({
            text:
              'Volunteers must not ask participants for passwords or payment card numbers.',
          }),

          new Paragraph({
            text: 'Youth activities',
            heading:
              HeadingLevel.HEADING_1,
          }),

          new Paragraph({
            text:
              'Volunteers assigned to applicable youth roles must complete any required background check before beginning that role.',
          }),
        ],
      },
    ],
  });

  const buffer =
    await Packer.toBuffer(document);

  await writeFile(
    path.join(
      samplesDirectory,
      'north-orbital-volunteer-handbook.docx',
    ),
    buffer,
  );
}

await createPdf();
await createDocx();

console.log(
  `Created fictional sample documents in ${samplesDirectory}`,
);
