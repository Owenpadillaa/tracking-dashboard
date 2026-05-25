import re
for fname in ['css_part1.css','css_part2.css','css_part3.css']:
    with open(fname,'r',encoding='utf-8',newline='') as f:
        lines = f.readlines()
    for i,line in enumerate(lines):
        if '@keyframes fadeUp' in line:
            print(f'fadeUp keyframe in {fname} at line {i+1}:')
            for j in range(i, min(i+15, len(lines))):
                print(f'  {j+1}: {repr(lines[j])}')
            print()
    # Find any rule with .tab-page and opacity
    for i,line in enumerate(lines):
        if '.tab-page' in line and 'opacity' in line.lower():
            print(f'{fname}:{i+1}: {repr(line.strip()[:120])}')