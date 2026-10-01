#!/usr/bin/env python3
"""
CPU age helper - map an Intel/AMD processor model string to its release year, so the
dashboard can flag machines whose processor is N+ years old ("Needs upgrade").

Rather than scrape every individual SKU (thousands of parts, brittle), we map the
processor GENERATION / SERIES - which the model number encodes - to the year that
generation shipped. Generation years verified against public sources (Intel ARK /
Wikipedia, AMD newsroom / Wikipedia) on 2026-07:

  Intel Core:        6=2015 7=2016 8=2017 9=2018 10=2019 11=2020 12=2022 13=2023 14=2024
  Intel Core Ultra:  series 1 (1xx) = 2023,  series 2 (2xx) = 2024
  AMD Ryzen:         1=2017 2=2018 3=2019 4=2020 5=2021 6=2022 7=2023 8=2024 9=2024
  AMD Ryzen AI:      (3xx) = 2024

Model-number -> generation rules:
  Intel Core i3/i5/i7/i9: 5-digit model -> first 2 digits are the gen (13500 -> 13);
    4-digit model starting with 1 -> first 2 digits (1135U/1065G7 -> 11/10),
    otherwise the first digit (8550U -> 8).
  AMD Ryzen: first digit of the 4-digit model is the series (5500U -> 5).
"""
from __future__ import annotations

import re

_INTEL_GEN_YEAR = {6: 2015, 7: 2016, 8: 2017, 9: 2018, 10: 2019,
                   11: 2020, 12: 2022, 13: 2023, 14: 2024}
_INTEL_ULTRA_YEAR = {1: 2023, 2: 2024}
_AMD_SERIES_YEAR = {1: 2017, 2: 2018, 3: 2019, 4: 2020, 5: 2021,
                    6: 2022, 7: 2023, 8: 2024, 9: 2024}


def release_year(cpu: str) -> int | None:
    """Best-effort release year for a CPU model string; None if unrecognized."""
    if not cpu:
        return None
    c = str(cpu).lower()

    # Intel Core Ultra: "Core Ultra 7 258V", "Core Ultra 9 285K", "Core Ultra 5 125H"
    m = re.search(r"core\s+ultra\s+\d+\s+(\d)\d{2}", c)
    if m:
        return _INTEL_ULTRA_YEAR.get(2 if m.group(1) == "2" else 1)

    # Intel Core i3/i5/i7/i9: "i5-1335U", "i7-8550U", "i7-1065G7", "i9-13900K"
    m = re.search(r"\bi[3579][\- ]?(\d{3,5})", c)
    if m:
        num = m.group(1)
        if len(num) >= 5:
            gen = int(num[:2])
        elif len(num) == 4:
            gen = int(num[:2]) if num[0] == "1" else int(num[0])
        else:
            gen = None
        if gen:
            return _INTEL_GEN_YEAR.get(gen, 2024 if gen > 14 else None)

    # AMD Ryzen AI: "Ryzen AI 7 PRO 350", "Ryzen AI 9 HX 370"
    if re.search(r"ryzen\s+ai\b", c) and re.search(r"\d{3}", c):
        return 2024

    # AMD Ryzen classic: "Ryzen 5 5500U", "Ryzen 7 PRO 5850U", "Ryzen 5 3500U"
    m = re.search(r"ryzen\s+\d+\s+(?:pro\s+)?(\d{4})", c)
    if m:
        return _AMD_SERIES_YEAR.get(int(m.group(1)[0]))

    return None


def age_years(cpu: str, today_year: int) -> int | None:
    y = release_year(cpu)
    return (today_year - y) if y else None
