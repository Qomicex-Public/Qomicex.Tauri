using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Qomicex.Launcher.Backend.Modules.Helpers
{
    public class AccountHelper
    {
        public static string NameToUuid(string name)
        {
            if (string.IsNullOrEmpty(name))
                return string.Empty;
            using (MD5 md5 = MD5.Create())
            {
                string input = $"OfflinePlayer:{name}";
                byte[] hashBytes = md5.ComputeHash(Encoding.UTF8.GetBytes(input));
                string md5Str = BitConverter.ToString(hashBytes).Replace("-", "").ToLower();

                string bit6 = ((Convert.ToByte(md5Str.Substring(12, 2), 16) & 15) | 48).ToString("x2");
                string bit8 = ((Convert.ToByte(md5Str.Substring(16, 2), 16) & 63) | 128).ToString("x2");

                string uuid = md5Str.Substring(0, 12) + bit6 + md5Str.Substring(14, 2) + bit8 + md5Str.Substring(18);

                return uuid;
            }
        }
    }
}
