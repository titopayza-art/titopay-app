<?php
/**
 * Ligcabho documents.
 *
 * Builds the PDFs a tenant receives once their lease is complete: the signed
 * lease agreement and the house rules. The clause text mirrors
 * assets/js/lease.js and house-rules.html, so the downloaded copy reads the
 * same as the copy the tenant signed on screen.
 */
declare(strict_types=1);
require_once __DIR__ . '/pdf.php';

function doc_day(?string $v): string
{
    if (!$v) return 'not stated';
    $ts = strtotime($v);
    return $ts ? date('d F Y', $ts) : $v;
}

function doc_stamp(?string $v): string
{
    if (!$v) return '';
    $ts = strtotime($v);
    return $ts ? date('d M Y \a\t H:i', $ts) . ' (SAST +2)' : $v;
}

function doc_money(?string $v): string
{
    $v = trim((string) $v);
    if ($v === '') return 'not stated';
    /* A rand amount in a lease reads as R3 200.00, not R3200. Anything that
       is not a plain number is printed as the office typed it. */
    $clean = str_replace([' ', ','], '', ltrim($v, 'Rr '));
    if (!is_numeric($clean)) return 'R' . ltrim($v, 'Rr ');
    return 'R' . number_format((float) $clean, 2, '.', ' ');
}

/** A named witness, or a ruled line for one to be written in by hand. */
function doc_witness(?string $v): string
{
    $v = trim((string) $v);
    return $v === '' ? '_________________________   Signature: _________________________' : $v;
}

function doc_val(?string $v): string
{
    $v = trim((string) $v);
    return $v === '' ? 'not stated' : $v;
}

/** The lease clauses, in the same order and wording as the on-screen lease. */
/**
 * The lease agreement, clause for clause.
 *
 * This is Ligcabho Le'Africa Properties' own lease, numbered exactly as the
 * signed paper version is, with the blanks filled in from the record. The
 * signing page reads these same clauses from the API, so what a student
 * agrees to on screen and what the PDF says can never drift apart.
 *
 * Returns [heading, body] pairs; the body carries its own sub-numbering.
 */
function lease_clauses(array $l, array $t): array
{
    $rent     = doc_money($l['monthly_rent'] ?? '');
    $adminFee = doc_money($l['admin_fee'] ?? '');
    $deposit  = doc_money($l['deposit'] ?? '');
    $house    = doc_val($l['residence'] ?? '');
    $room     = trim((string) ($l['room_number'] ?? ''));
    $where    = $house . ($room !== '' ? ', room ' . $room : '');
    $landlord = doc_val($t['landlord_entity'] ?? "LIGCABHO LE'AFRICA PROPERTIES");
    $lAddr    = doc_val($t['landlord_address'] ?? '');
    $lEmail   = doc_val($t['landlord_email'] ?? '');
    $from     = doc_day($l['commencement_date'] ?? '');
    $to       = doc_day($l['end_date'] ?? '');
    $people   = (int) ($l['max_occupants'] ?? 0);
    $people   = $people > 0 ? (string) $people : '____';

    return [
        ['Definitions',
         "1.1 Agreement refers to this Lease Agreement entered between the Landlord and the Tenant.\n"
         . "1.2 Business Day refers to any day other than Saturday, Sunday, or Public Holidays.\n"
         . "1.3 Leased Property refers to the property situated at: $where.\n"
         . "1.4 Landlord refers to the owner of the property or any authorized agent or party acting on their "
         . "behalf.\n"
         . "1.5 Lease Amount refers to the monthly rental amount payable by the Tenant to the Landlord on the "
         . "agreed date.\n"
         . "1.6 Party refers to either the Landlord or the Tenant, and “Parties” refers to both.\n"
         . "1.7 Tenant refers to the student leasing the property, as fully described in this Agreement.\n"
         . "1.8 Signature Date refers to the date of signature of this Agreement by the last signing party."],

        ['Commencement and duration',
         "2.1 This lease shall commence on $from (“the Commencement Date”) and shall endure until "
         . "$to (“the Initial Period”).\n"
         . "2.2 Notwithstanding clause 2.1, the lease shall continue on a month-to-month basis after the Initial "
         . "Period, subject to either party’s right to terminate by providing one calendar month’s "
         . "written notice."],

        ['Rent',
         "3.1 The monthly rental payable by the Tenant to the Landlord shall be an amount of $rent per month.\n"
         . "3.2 Rent is payable in advance, on or before the 1st of each month and no later than the 7th of each "
         . "month.\n"
         . "3.3 The monthly rental amount is inclusive of Value Added Tax (if applicable)."],

        ['Administration fees',
         "4.1 The Tenant shall, upon signing this Agreement, pay admin fee amount of $adminFee (if applicable).\n"
         . "4.2 Administrative fees are not considered part of the deposit and are non-refundable.\n"
         . "4.3 In the event of a breach of the Agreement as outlined in clause 9, the deposit will not be "
         . "refunded.\n"
         . "4.4 The deposit payable under this Agreement is $deposit."],

        ['Tenant’s obligations',
         "5.1 The Tenant shall use the premises solely for student accommodation purposes.\n"
         . "5.2 The Tenant shall maintain the premises in good order and shall not engage in any conduct that "
         . "causes damage or nuisance.\n"
         . "5.3 The Tenant shall comply with applicable laws, bylaws, and house rules.\n"
         . "5.4 The premises may not be occupied by more than $people persons without prior written consent.\n"
         . "5.5 The Tenant must inspect the premises with the Landlord before taking occupation and report defects "
         . "within 14 days.\n"
         . "5.6 The Tenant shall not make any unauthorized alterations, improvements, or additions to the "
         . "premises.\n"
         . "5.7 The Tenant is responsible for all costs of repairing damages caused by negligence or misuse of the "
         . "property.\n"
         . "5.8 The Tenant shall allow reasonable access for the Landlord to inspect or repair the premises, upon "
         . "reasonable notice."],

        ['Landlord’s rights',
         "6.1 The Landlord or authorized personnel may enter and inspect the premises at reasonable times, upon "
         . "prior notice.\n"
         . "6.2 The Landlord may display “To Let” signs two months before the lease’s "
         . "expiry.\n"
         . "6.3 The Landlord may terminate the lease if the property is sold."],

        ['Indemnity',
         "7.1 The Landlord shall not be responsible for interruptions in services or damages to the Tenant’s "
         . "property.\n"
         . "7.2 The Tenant indemnifies the Landlord from claims arising due to personal injury, theft, or loss "
         . "within the premises."],

        ['Insurance',
         "8.1 The Tenant is required to obtain and maintain renter’s insurance to cover their personal "
         . "belongings within the premises.\n"
         . "8.2 The Tenant shall not engage in activities that increase the risk of fire or other hazards to the "
         . "property."],

        ['Breach',
         "9.1 The Landlord may cancel this lease immediately if the Tenant:\n"
         . "9.1.1 Fails to pay rent by the due date.\n"
         . "9.1.2 Breaches any material terms and fails to remedy the breach within 7 days of written notice.\n"
         . "9.1.3 Commits an act of insolvency or passes away (if an individual).\n"
         . "9.2 In the event of termination, the Tenant must vacate the premises immediately. Holding over will "
         . "result in damages equivalent to the monthly rent."],

        ['Domicilium',
         "10.1 Landlord’s Address:\n"
         . "Physical Address: $lAddr\n"
         . "E-mail Address: $lEmail\n"
         . "10.2 Tenant’s Address:\n"
         . "Physical Home Address: " . doc_val($l['home_address'] ?? '') . "\n"
         . "E-mail Address: " . doc_val($l['tenant_email'] ?? '') . "\n"
         . "Next of Kin Name: " . doc_val($l['kin_name'] ?? '') . "\n"
         . "Next of Kin Contact: " . doc_val($l['kin_contact'] ?? '')],

        ['General',
         "11.1 This Agreement constitutes the entire agreement between the Parties. Amendments must be in writing "
         . "and signed by both Parties.\n"
         . "11.2 The Landlord retains the right to enforce all terms strictly, even if leniency is shown "
         . "previously.\n"
         . "11.3 Legal disputes will be settled in accordance with South African law.\n"
         . "11.4 The Ligcabho house rules form part of this Agreement and are binding on the Tenant. A copy is "
         . "issued with this lease and published on the website."],

        ['Special conditions',
         trim((string) ($l['special_conditions'] ?? '')) !== ''
            ? (string) $l['special_conditions']
            : 'None recorded for this lease.'],
    ];
}

/**
 * The clauses to print for this lease.
 *
 * Once a lease is signed, its wording is frozen: the snapshot taken at
 * signature is what prints, for ever. Changing the agreement for next
 * year's intake can never rewrite what somebody already signed.
 */
function lease_terms(array $l, array $t): array
{
    $snap = trim((string) ($l['terms_snapshot'] ?? ''));
    if ($snap !== '') {
        $data = json_decode($snap, true);
        if (is_array($data) && !empty($data['clauses'])) return $data['clauses'];
    }
    return lease_clauses($l, $t);
}

/** The landlord's details as they stood when the lease was signed. */
function lease_landlord(array $l, array $t): array
{
    $snap = trim((string) ($l['terms_snapshot'] ?? ''));
    if ($snap !== '') {
        $data = json_decode($snap, true);
        if (is_array($data) && !empty($data['terms'])) return $data['terms'];
    }
    return $t;
}

/** The signed (or unsigned) lease agreement as a PDF. */
function lease_pdf(array $l, array $terms, array $site): string
{
    $terms    = lease_landlord($l, $terms);
    $tenant   = trim(($l['tenant_name'] ?? '') . ' ' . ($l['tenant_surname'] ?? ''));
    $landlord = doc_val($terms['landlord_entity'] ?? "LIGCABHO LE’AFRICA PROPERTIES");

    $pdf = new Pdf([
        'title'  => 'Lease Agreement - ' . $tenant,
        'footer' => ($site['name'] ?? 'Ligcabho') . '   ' . ($site['phone'] ?? ''),
    ]);

    $pdf->title('Lease Agreement', $landlord . ' and ' . $tenant);

    $pdf->text('This Lease Agreement is entered into by and between:', 10);
    $pdf->space(6);

    $pdf->row('Name', doc_val($l['tenant_name'] ?? ''));
    $pdf->row('Surname', doc_val($l['tenant_surname'] ?? ''));
    $pdf->row('Identity Number', doc_val($l['tenant_id_number'] ?? ''));
    $pdf->row('Cell phone Number', doc_val($l['tenant_phone'] ?? ''));
    $pdf->row('Student Number', doc_val($l['student_number'] ?? ''));
    $pdf->row('Name of Institution', doc_val($l['institution'] ?? ''));
    $pdf->row('Name of the Course', doc_val($l['course'] ?? ''));
    $pdf->row('Year of Study', doc_val($l['year_of_study'] ?? ''));
    $pdf->space(4);
    $pdf->text('(Hereinafter referred to as “the Tenant”)', 9);
    $pdf->space(8);
    $pdf->text('AND', 10, true);
    $pdf->space(4);
    $pdf->text($landlord, 10.5, true);
    $pdf->text('(Hereinafter referred to as “the Landlord”)', 9);

    $pdf->heading('The leased property');
    $pdf->row('Residence', doc_val($l['residence'] ?? ''));
    $pdf->row('Room number', doc_val($l['room_number'] ?? ''));
    $pdf->row('Room type', doc_val($l['room_type'] ?? ''));
    $pdf->row('Commencement Date', doc_day($l['commencement_date'] ?? ''));
    $pdf->row('Initial Period ends', doc_day($l['end_date'] ?? ''));
    $pdf->row('Monthly rental', doc_money($l['monthly_rent'] ?? ''));
    $pdf->row('Deposit', doc_money($l['deposit'] ?? ''));
    $pdf->row('Administration fee', doc_money($l['admin_fee'] ?? ''));
    if (!empty($l['funder'])) $pdf->row('Funder', $l['funder']);

    $pdf->space(6);
    foreach (lease_terms($l, $terms) as $i => $c) {
        $pdf->heading(($i + 1) . '. ' . strtoupper($c[0]), 10.5, 10.0);
        $pdf->text($c[1], 9.5);
        $pdf->space(3);
    }

    /* The closing block of the paper agreement, kept word for word. */
    $signedAt = doc_val($l['signed_at_place'] ?? ($site['city'] ?? 'Mbombela'));
    $when     = $l['tenant_signed_at'] ?? '';
    $day      = $when ? date('j', strtotime($when)) : '____';
    $month    = $when ? date('F', strtotime($when)) : '________________';
    $year     = $when ? date('y', strtotime($when)) : '____';

    $pdf->heading('Signed');
    $pdf->text("THUS DONE AND SIGNED AT $signedAt ON THIS $day DAY OF $month 20$year", 10, true);
    $pdf->space(6);
    $pdf->text('This lease was signed electronically. The signature, the date, the time and the IP address it was '
        . 'signed from are recorded against this agreement. Under the Electronic Communications and Transactions '
        . 'Act 25 of 2002, an electronic signature is as binding as a signature on paper.', 9);
    $pdf->space(8);

    $pdf->text('TENANT', 9.5, true);
    $pdf->signature('Tenant', doc_val($l['tenant_signed_name'] ?? $tenant), doc_stamp($l['tenant_signed_at'] ?? ''));
    $pdf->space(6);
    $pdf->text('Witnesses', 9, true);
    $pdf->text('1. ' . doc_witness($l['tenant_witness_1'] ?? ''), 9);
    $pdf->text('2. ' . doc_witness($l['tenant_witness_2'] ?? ''), 9);

    $pdf->space(12);
    $pdf->text('LANDLORD', 9.5, true);
    $pdf->signature('For ' . $landlord,
        doc_val($l['landlord_signed_name'] ?? 'Awaiting counter-signature'),
        doc_stamp($l['landlord_signed_at'] ?? ''));
    $pdf->space(6);
    $pdf->text('Witnesses', 9, true);
    $pdf->text('1. ' . doc_witness($l['landlord_witness_1'] ?? ''), 9);
    $pdf->text('2. ' . doc_witness($l['landlord_witness_2'] ?? ''), 9);

    if (!empty($l['tenant_sign_ip'])) {
        $pdf->space(10);
        $pdf->text('Signed from IP ' . $l['tenant_sign_ip'] . '. Agreement reference ' . ($l['token'] ?? ''), 8);
    }

    return $pdf->output();
}

/** The eleven house rule policies as a PDF. */
function house_rules_pdf(array $site): string
{
    $rules = [
        ['Water and electricity consumption',
         'Water and electricity are supplied for reasonable residential use. Wastage, unattended taps, heaters left '
         . "running and tampering with meters or the backup supply are charged to the student's account."],
        ['Consideration of others',
         'A residence is a shared home. Noise is kept down at all times and strictly after 22h00, and behaviour that '
         . "disturbs other students' rest or study is a breach of the lease."],
        ['Care of the building, common areas and rooms',
         'Students keep their rooms clean and leave common areas as they would like to find them. Damage and '
         . "vandalism are charged to the responsible student's account and repaired once paid."],
        ['Smoking, drugs and alcohol policy',
         'No smoking inside rooms, passages or common areas. Illegal substances are prohibited on all Ligcabho '
         . 'property, and intoxicated conduct that endangers or disturbs others is a breach of the lease.'],
        ['Medical conditions and disabilities',
         'Students must declare medical conditions, allergies and disabilities on application so that the residence '
         . 'can place them appropriately and respond correctly in an emergency.'],
        ['Security and safety policy',
         'Access control, gate and door discipline, and the instructions of security personnel are binding on every '
         . 'student. Keys, tags and access codes may not be shared or duplicated.'],
        ['Visitors',
         'Visitors sign in at the front desk. Scheduled sleepovers are charged at R135 per person with proof of '
         . "payment; unscheduled sleepovers are charged at R200 per visitor to the student's rental account."],
        ['General',
         'House comms, notices in the lobby and instructions from the house warden form part of these rules. '
         . 'Furniture may not be removed from rooms or common areas.'],
        ['Pregnancy policy',
         'A pregnant student must notify the manager so that suitable arrangements can be made. Residences are not '
         . 'equipped as family accommodation and infants may not be housed in student rooms.'],
        ['Student parking regulations',
         "Parking is available at selected residences, by allocation only, and vehicles are parked at the owner's "
         . 'risk. Unroadworthy or unlicensed vehicles may not be stored on the premises.'],
        ['Compliance - failure to observe',
         "Failure to observe these rules leads to a written warning, a charge to the student's account, and in "
         . 'serious or repeated cases cancellation of the lease and the funder being informed.'],
    ];

    $pdf = new Pdf([
        'title'  => 'House Rules',
        'footer' => ($site['name'] ?? 'Ligcabho') . '   ' . ($site['phone'] ?? ''),
    ]);
    $pdf->title('House Rules', ($site['name'] ?? '') . ' - issued with every lease agreement');
    $pdf->text('These rules form part of your lease agreement and are binding on every student in residence. Keep '
        . 'this copy: the front desk works from the same document.', 9.5);

    foreach ($rules as $i => $r) {
        $pdf->text(($i + 1) . '. ' . $r[0], 10.5, true);
        $pdf->text($r[1], 9.5);
        $pdf->space(4);
    }

    $pdf->heading('Maintenance turnaround');
    $pdf->bullet('12 hours: water wastage (not flood related), globes in student rooms or critical areas, toilets, '
        . 'locks, showers that are not usable, stoves.');
    $pdf->bullet('36 hours: carpets, tiles, hydroboilers, basins, taps, flush masters, shower doors.');
    $pdf->bullet('Items vandalised by students are not subject to these turnaround times.');
    $pdf->bullet('Matters recorded on a Friday after 15h00 may only be attended to on the Monday, unless it is an '
        . 'emergency. A standby team attends to emergencies over weekends.');

    $pdf->heading('Who to call');
    $pdf->row('Ligcabho emergency line', '071 640 1574 (24 hours)');
    $pdf->row('Head office', doc_val($site['phone'] ?? ''));
    $pdf->row('Police', '10111');
    $pdf->row('Ambulance and fire', '10177');

    return $pdf->output();
}

/** An invoice or a quote as a PDF, with the banking details on it. */
function invoice_pdf(array $inv, array $terms, array $site): string
{
    $isQuote = ($inv['kind'] ?? 'invoice') === 'quote';
    $word    = $isQuote ? 'Quotation' : 'Tax Invoice';
    $bank    = $terms['bank'] ?? [];

    $pdf = new Pdf([
        'title'  => $word . ' ' . ($inv['ref'] ?? ''),
        'footer' => ($site['name'] ?? 'Ligcabho') . '   ' . ($site['phone'] ?? ''),
    ]);

    $pdf->title($word, ($inv['ref'] ?? '') . '  ·  ' . doc_day($inv['issued_on'] ?? ''));

    $pdf->heading('From');
    $pdf->row('Landlord', doc_val($terms['landlord_entity'] ?? ''));
    $pdf->row('Address', doc_val($terms['landlord_address'] ?? ''));
    $pdf->row('Email', doc_val($terms['landlord_email'] ?? ''));

    $pdf->heading('To');
    $pdf->row('Name', doc_val($inv['name'] ?? ''));
    $pdf->row('Email', doc_val($inv['email'] ?? ''));
    if (!empty($inv['phone']))     $pdf->row('Phone', $inv['phone']);
    if (!empty($inv['residence'])) $pdf->row('Residence', $inv['residence']);
    if (!empty($inv['room']))      $pdf->row('Room', $inv['room']);

    $pdf->heading($isQuote ? 'Quoted' : 'Charged');
    $total = 0.0;
    foreach ((array) json_decode((string) ($inv['items'] ?? '[]'), true) as $line) {
        $amount = (float) ($line['amount'] ?? 0);
        $qty    = (int) ($line['qty'] ?? 1);
        $total += $qty * $amount;
        $pdf->row(($qty > 1 ? $qty . ' x ' : '') . ($line['description'] ?? ''),
            'R' . number_format($qty * $amount, 2));
    }
    $pdf->space(4);
    $pdf->row('Total', 'R' . number_format($total, 2), 11.5);

    if (!empty($inv['due_on'])) {
        $pdf->space(6);
        $pdf->text($isQuote ? 'Valid until ' . doc_day($inv['due_on'])
                            : 'Payment due by ' . doc_day($inv['due_on']), 10, true);
    }
    if (($inv['status'] ?? '') === 'paid') {
        $pdf->space(4);
        $pdf->text('PAID' . (!empty($inv['paid_on']) ? ' on ' . doc_day($inv['paid_on']) : ''), 11, true);
    }

    if (!$isQuote) {
        $pdf->heading('How to pay');
        $pdf->row('Bank', doc_val($bank['bank_name'] ?? ''));
        $pdf->row('Account name', doc_val($bank['account_name'] ?? ''));
        $pdf->row('Account number', doc_val($bank['account_number'] ?? ''));
        $pdf->row('Account type', doc_val($bank['account_type'] ?? ''));
        $pdf->row('Reference', doc_val($inv['ref'] ?? ''));
        $pdf->space(6);
        $pdf->text('Use the reference exactly as it appears above, so the payment can be matched to this '
            . 'invoice. Send the proof of payment to ' . doc_val($terms['landlord_email'] ?? '') . '.', 9.5);
    }

    if (!empty($inv['note'])) {
        $pdf->heading('Note');
        $pdf->text($inv['note'], 9.5);
    }

    return $pdf->output();
}
