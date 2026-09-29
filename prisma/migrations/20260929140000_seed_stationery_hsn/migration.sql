-- Shared (businessId NULL) stationery HSN dataset, visible to every business.
-- GST rates as revised with effect from 22 Sep 2025 (GST 2.0).
INSERT INTO "HSNMaster" ("id", "businessId", "hsnCode", "description", "chapter", "heading", "keywords", "gstRate", "effectiveFrom", "isActive")
SELECT gen_random_uuid()::text, NULL, v.code, v.description, left(v.code, 2), left(v.code, 4), v.keywords, v.rate, TIMESTAMP '2025-09-22', true
FROM (VALUES
  ('48202000', 'Exercise books, notebooks, graph books, laboratory notebooks', 'notebook, exercise book, copy, graph book, lab notebook, long book, drawing book', 0),
  ('96091000', 'Pencils (black lead and coloured pencils)', 'pencil, lead pencil, colour pencil, color pencil, wooden pencil', 0),
  ('96099030', 'Crayons', 'crayon, wax crayon, oil crayon', 0),
  ('96099090', 'Pastels, drawing charcoals and other items of heading 9609', 'pastel, oil pastel, charcoal, drawing charcoal', 0),
  ('82142010', 'Pencil sharpeners and blades therefor', 'sharpener, pencil sharpener', 0),
  ('40169200', 'Erasers of vulcanised rubber', 'eraser, rubber', 0),
  ('49051000', 'Globes', 'globe', 0),
  ('49059900', 'Maps and hydrographic or similar charts (other than in book form)', 'map, atlas chart, wall chart, chart', 0),
  ('49011010', 'Printed books', 'book, text book, textbook', 0),
  ('90172010', 'Drawing instruments, mathematical and geometry boxes', 'geometry box, maths box, mathematical instrument box, compass, divider, protractor', 5),
  ('32131000', 'Artists'' and students'' colours in sets (colour boxes)', 'colour box, color box, water colour, poster colour, paint set', 5),
  ('960810', 'Ball point pens', 'ball pen, ballpoint, pen, gel pen, use and throw', 18),
  ('96082000', 'Felt-tipped and other porous-tipped pens and markers', 'marker, highlighter, sketch pen, whiteboard marker, permanent marker, cd marker', 18),
  ('960830', 'Fountain pens and stylograph pens', 'fountain pen, ink pen', 18),
  ('96086000', 'Refills for ball point pens, comprising the ball point and ink reservoir', 'refill, pen refill, ball pen refill, gel refill', 18),
  ('96089100', 'Pen nibs and nib points', 'nib, pen nib', 18),
  ('32159010', 'Fountain pen ink', 'ink, fountain pen ink, ink bottle', 18),
  ('96110000', 'Date, sealing or numbering stamps, hand-operated', 'stamp, rubber stamp, date stamp, numbering stamp', 18),
  ('96122000', 'Ink pads', 'stamp pad, ink pad', 18),
  ('48025690', 'Uncoated writing/printing paper (A4, legal) in sheets', 'a4, a4 paper, copier paper, printing paper, ream, legal paper', 18),
  ('48025790', 'Other uncoated writing and printing paper', 'paper, bond paper, drawing sheet', 18),
  ('482010', 'Registers, account books, order/receipt books, letter pads, memo pads, diaries', 'register, account book, receipt book, letter pad, memo pad, diary, bill book', 18),
  ('48203000', 'Binders, folders and file covers of paper or paperboard', 'file, file cover, folder, binder, box file', 18),
  ('48204000', 'Manifold business forms and interleaved carbon sets', 'carbon set, business form, duplicate book', 18),
  ('48091000', 'Carbon paper and similar copying papers', 'carbon paper', 18),
  ('48171000', 'Envelopes', 'envelope, cover, postal cover', 18),
  ('48173000', 'Boxes, pouches and wallets of paper containing stationery', 'stationery box, writing compendium', 18),
  ('392610', 'Office or school supplies of plastics', 'plastic file, clear bag, l folder, cobra file, plastic ruler, scale, pencil box', 18),
  ('39191000', 'Self-adhesive tapes in rolls up to 20 cm wide', 'tape, cello tape, cellotape, bopp tape, packing tape, masking tape, double side tape', 18),
  ('35061000', 'Glue and adhesives for retail sale (up to 1 kg)', 'glue, gum, fevistick, glue stick, adhesive, fevicol', 18),
  ('382499', 'Correction fluid and correction pens', 'correction pen, whitener, correction fluid, correction tape', 18),
  ('83051000', 'Fittings for loose-leaf binders or files', 'binder fitting, file clip, lever arch mechanism', 18),
  ('83052000', 'Staples in strips', 'staple, stapler pin, stapler pins', 18),
  ('830590', 'Paper clips, binder clips, letter clips and similar office articles', 'paper clip, binder clip, gem clip, bulldog clip, clip', 18),
  ('847290', 'Staplers, punches and other office machines', 'stapler, punch, paper punch, hole punch', 18),
  ('82130000', 'Scissors', 'scissors, scissor, kainchi', 18),
  ('84701000', 'Electronic calculators', 'calculator', 18)
) AS v(code, description, keywords, rate)
WHERE NOT EXISTS (SELECT 1 FROM "HSNMaster" h WHERE h."businessId" IS NULL AND h."hsnCode" = v.code);
