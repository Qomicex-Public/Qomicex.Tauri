using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using static Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge.CurseForgeBase;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class DataPacks : CurseForgeBase
    {
        public DataPacks(string ApiKey) : base(ApiKey, GetSearchUrl(), GetModUrl()) { }
        private static string GetSearchUrl()
        {
            return "/v1/mods/search?gameId=432&classId=6945";
        }

        private static string GetModUrl()
        {
            return "/v1/mods/";
        }

        /// <summary>
        /// 获取推荐的DataPack列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        public async Task<List<CurseForgeSearchResult>> GetRecommendDataPacks(string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.GetRecommend(GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的DataPack
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        public new async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.SearchAsync(SearchFilter, GameVersions, Categories, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步获取指定DataPack的详细信息
        /// </summary>
        /// <param name="Id">ModId</param>
        /// <returns>DataPack信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<CurseForgeInfo> GetModInfoAsync(string Id)
        {
            return await base.GetInfoAsync(Id);
        }

        public enum Category
        {
            Magic = 6952,
            Miscellaneous = 6947,
            Fantasy = 6949,
            ModSupport = 6946,
            Tech = 6951,
            Library = 6950,
            Utility = 6953,
            Adventure = 6948,
        }
    }
}
