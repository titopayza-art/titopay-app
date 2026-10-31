<?php
// Where South African events are, roughly: town centres and province centres,
// for "events near me" without any map service or API key. Distances are
// straight-line kilometres between town centres, which is all a filter needs.
declare(strict_types=1);

const SA_PLACES = [
    // Gauteng
    'johannesburg' => [-26.2041, 28.0473, 'Gauteng'], 'pretoria' => [-25.7479, 28.2293, 'Gauteng'], 'tshwane' => [-25.7479, 28.2293, 'Gauteng'],
    'soweto' => [-26.2485, 27.8540, 'Gauteng'], 'sandton' => [-26.1076, 28.0567, 'Gauteng'], 'randburg' => [-26.0936, 28.0064, 'Gauteng'],
    'roodepoort' => [-26.1625, 27.8725, 'Gauteng'], 'midrand' => [-25.9992, 28.1263, 'Gauteng'], 'centurion' => [-25.8603, 28.1894, 'Gauteng'],
    'germiston' => [-26.2309, 28.1771, 'Gauteng'], 'benoni' => [-26.1885, 28.3208, 'Gauteng'], 'boksburg' => [-26.2125, 28.2625, 'Gauteng'],
    'kempton park' => [-26.1000, 28.2333, 'Gauteng'], 'alberton' => [-26.2672, 28.1222, 'Gauteng'], 'springs' => [-26.2500, 28.4000, 'Gauteng'],
    'krugersdorp' => [-26.0857, 27.7750, 'Gauteng'], 'vereeniging' => [-26.6731, 27.9261, 'Gauteng'], 'vanderbijlpark' => [-26.7000, 27.8167, 'Gauteng'],
    'tembisa' => [-25.9964, 28.2268, 'Gauteng'], 'newtown' => [-26.2023, 28.0336, 'Gauteng'], 'braamfontein' => [-26.1929, 28.0305, 'Gauteng'],
    'rosebank' => [-26.1452, 28.0436, 'Gauteng'], 'fourways' => [-26.0157, 28.0060, 'Gauteng'], 'maboneng' => [-26.2044, 28.0592, 'Gauteng'],
    // Western Cape
    'cape town' => [-33.9249, 18.4241, 'Western Cape'], 'stellenbosch' => [-33.9321, 18.8602, 'Western Cape'], 'paarl' => [-33.7342, 18.9621, 'Western Cape'],
    'franschhoek' => [-33.9133, 19.1169, 'Western Cape'], 'somerset west' => [-34.0757, 18.8433, 'Western Cape'], 'bellville' => [-33.9003, 18.6290, 'Western Cape'],
    'durbanville' => [-33.8320, 18.6470, 'Western Cape'], 'george' => [-33.9630, 22.4617, 'Western Cape'], 'knysna' => [-34.0363, 23.0471, 'Western Cape'],
    'mossel bay' => [-34.1831, 22.1460, 'Western Cape'], 'hermanus' => [-34.4187, 19.2345, 'Western Cape'], 'worcester' => [-33.6461, 19.4485, 'Western Cape'],
    'plettenberg bay' => [-34.0527, 23.3716, 'Western Cape'], 'oudtshoorn' => [-33.5928, 22.2014, 'Western Cape'], 'muizenberg' => [-34.1075, 18.4694, 'Western Cape'],
    // KwaZulu-Natal
    'durban' => [-29.8587, 31.0218, 'KwaZulu-Natal'], 'umhlanga' => [-29.7280, 31.0816, 'KwaZulu-Natal'], 'pietermaritzburg' => [-29.6006, 30.3794, 'KwaZulu-Natal'],
    'ballito' => [-29.5390, 31.2140, 'KwaZulu-Natal'], 'richards bay' => [-28.7807, 32.0383, 'KwaZulu-Natal'], 'newcastle' => [-27.7580, 29.9318, 'KwaZulu-Natal'],
    'ladysmith' => [-28.5539, 29.7784, 'KwaZulu-Natal'], 'port shepstone' => [-30.7414, 30.4550, 'KwaZulu-Natal'], 'umlazi' => [-29.9705, 30.8869, 'KwaZulu-Natal'],
    // Eastern Cape
    'gqeberha' => [-33.9608, 25.6022, 'Eastern Cape'], 'port elizabeth' => [-33.9608, 25.6022, 'Eastern Cape'], 'east london' => [-33.0153, 27.9116, 'Eastern Cape'],
    'mthatha' => [-31.5889, 28.7844, 'Eastern Cape'], 'makhanda' => [-33.3042, 26.5328, 'Eastern Cape'], 'grahamstown' => [-33.3042, 26.5328, 'Eastern Cape'],
    'jeffreys bay' => [-34.0507, 24.9220, 'Eastern Cape'], 'komani' => [-31.8976, 26.8753, 'Eastern Cape'],
    // Free State
    'bloemfontein' => [-29.0852, 26.1596, 'Free State'], 'welkom' => [-27.9774, 26.7351, 'Free State'], 'bethlehem' => [-28.2300, 28.3071, 'Free State'],
    'kroonstad' => [-27.6504, 27.2349, 'Free State'], 'sasolburg' => [-26.8136, 27.8169, 'Free State'], 'clarens' => [-28.5147, 28.4239, 'Free State'],
    // Limpopo
    'polokwane' => [-23.9045, 29.4689, 'Limpopo'], 'thohoyandou' => [-22.9456, 30.4850, 'Limpopo'], 'tzaneen' => [-23.8332, 30.1635, 'Limpopo'],
    'mokopane' => [-24.1944, 29.0097, 'Limpopo'], 'bela-bela' => [-24.8850, 28.2930, 'Limpopo'], 'musina' => [-22.3381, 30.0414, 'Limpopo'],
    // Mpumalanga
    'mbombela' => [-25.4753, 30.9694, 'Mpumalanga'], 'nelspruit' => [-25.4753, 30.9694, 'Mpumalanga'], 'emalahleni' => [-25.8713, 29.2332, 'Mpumalanga'],
    'witbank' => [-25.8713, 29.2332, 'Mpumalanga'], 'secunda' => [-26.5500, 29.1667, 'Mpumalanga'], 'middelburg' => [-25.7751, 29.4648, 'Mpumalanga'],
    'hazyview' => [-25.0466, 31.1265, 'Mpumalanga'], 'white river' => [-25.3302, 31.0118, 'Mpumalanga'],
    // North West
    'rustenburg' => [-25.6676, 27.2421, 'North West'], 'mahikeng' => [-25.8560, 25.6403, 'North West'], 'potchefstroom' => [-26.7145, 27.0970, 'North West'],
    'klerksdorp' => [-26.8521, 26.6667, 'North West'], 'brits' => [-25.6347, 27.7802, 'North West'], 'hartbeespoort' => [-25.7240, 27.8466, 'North West'],
    'sun city' => [-25.3346, 27.0927, 'North West'],
    // Northern Cape
    'kimberley' => [-28.7282, 24.7499, 'Northern Cape'], 'upington' => [-28.4478, 21.2561, 'Northern Cape'], 'springbok' => [-29.6643, 17.8865, 'Northern Cape'],
];
const SA_PROVINCE_CENTRES = [
    'Gauteng' => [-26.2708, 28.1123], 'Western Cape' => [-33.2278, 21.8569], 'KwaZulu-Natal' => [-28.5306, 30.8958], 'Eastern Cape' => [-32.2968, 26.4194],
    'Free State' => [-28.4541, 26.7968], 'Limpopo' => [-23.4013, 29.4179], 'Mpumalanga' => [-25.5653, 30.5279], 'North West' => [-26.6639, 25.2838],
    'Northern Cape' => [-29.0467, 21.8569],
];
// [lat, lng] for an event's town, or its province centre, or null.
function place_of(?string $city, ?string $province): ?array
{
    $k = mb_strtolower(trim((string) $city));
    if ($k !== '' && isset(SA_PLACES[$k])) return [SA_PLACES[$k][0], SA_PLACES[$k][1]];
    // "Zoo Lake, Johannesburg" or "Soweto (Orlando)": try each word group.
    foreach (preg_split('/[,()\/-]+/', $k) as $part) { $part = trim($part); if ($part !== '' && isset(SA_PLACES[$part])) return [SA_PLACES[$part][0], SA_PLACES[$part][1]]; }
    return $province && isset(SA_PROVINCE_CENTRES[$province]) ? SA_PROVINCE_CENTRES[$province] : null;
}
function km_between(array $a, array $b): float
{
    $r = 6371.0;
    $dLat = deg2rad($b[0] - $a[0]); $dLng = deg2rad($b[1] - $a[1]);
    $h = sin($dLat / 2) ** 2 + cos(deg2rad($a[0])) * cos(deg2rad($b[0])) * sin($dLng / 2) ** 2;
    return 2 * $r * asin(min(1, sqrt($h)));
}
