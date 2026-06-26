using System;
using System.Collections.Generic;
using System.Text;

namespace Qomicex.Launcher.Backend.ScaffoldingConnector.Core
{
    public class RoomCode
    {
        static readonly char[] MapTable = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ".ToCharArray();

        static int MapChar(char c)
        {
            int index = Array.IndexOf(MapTable, c);
            if (index < 0) throw new Exception($"Invalid char: {c}");
            return index;
        }

        static int ParseLittleEndian(string part)
        {
            part = part.Replace("-", "");
            int value = 0;
            int shift = 0;

            foreach (char c in part)
            {
                int mapped = MapChar(c);
                value |= (mapped << shift);
                shift += 5;
            }

            return value;
        }

        public static bool Validate(string code)
        {
            var parts = code.Split('/', '-');
            string N1 = parts[1];
            string N2 = parts[2];

            int value = ParseLittleEndian(N1 + N2);
            return value % 7 == 0;
        }

        public static string Generate()
        {
            Random rnd = new Random();
            string N1, N2;

            while (true)
            {
                N1 = rnd.GetString(MapTable, 4);
                N2 = rnd.GetString(MapTable, 4);

                int value = ParseLittleEndian(N1 + N2);
                if (value % 7 == 0) break;
            }

            string S1 = rnd.GetString(MapTable, 4);
            string S2 = rnd.GetString(MapTable, 4);

            return $"U/{N1}-{N2}-{S1}-{S2}";
        }

    }
}
